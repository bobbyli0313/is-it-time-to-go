/**
 * On-demand price collection, on the request path.
 *
 * ## Why this exists
 *
 * Collection used to be strictly offline: the app read a dataset that a batch job had
 * filled, and a city nobody had collected simply reported its hotel dimension as
 * unavailable. With very few users that trade is the wrong way round — the first person
 * to search a city is exactly the person who should cause it to be collected, and
 * waiting for an operator to run a cron job means the app is empty precisely when
 * someone is looking at it.
 *
 * ## What it costs, and how that is contained
 *
 * The evaluation key allows **50 requests per day**. A naive request-path collector
 * burns that in fifty searches and then fails for everyone. Four rules prevent it:
 *
 *  1. **Freshness first.** A city whose samples already cover the requested night is
 *     not collected again until they age past `freshHours` (default 24). The dataset
 *     *is* the cache; the common case costs zero requests.
 *  2. **A daily budget, counted on disk.** Every outbound request is tallied against a
 *     per-day counter that survives restarts, and collection stops at the limit rather
 *     than discovering it as a 403.
 *  3. **One city, one date, one request.** The Hotelbeds adapter is asked for a single
 *     city-night, which is all the median needs and the smallest unit the quota allows.
 *  4. **Nothing here can fail a score.** Every error path returns a reason. The caller
 *     keeps whatever the dataset already had; the dimension degrades to "unavailable",
 *     which is the same outcome as before this module existed.
 *
 * ## Concurrency
 *
 * In-process calls for the same city/date share one promise (single-flight), so a burst
 * of searches for the same destination costs one request rather than one each. Separate
 * processes cannot share that — a serverless deployment gives each instance its own
 * counter and its own in-flight map — so the budget is documented as per-instance and
 * should be set conservatively when more than one instance is running.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { City, OnDemandOutcome } from "../../scoring/types";
import { addDays } from "../../scoring/dates";
import type { HotelDataset, HotelPriceSample, HotelProperty } from "../hotel-dataset";
import {
  DEFAULT_BASIS,
  reduceToPropertyMedians,
  type HotelDisclosure,
} from "../hotel-dataset";
import type { CollectorAdapter, RawRate } from "./types";
import { createPoliteFetch, USER_AGENT } from "./http";
import { baselineForCurrency, type BaselineResult } from "./baseline";
import { RobotsCache } from "./robots";
import { mergeDataset, writeDatasetAtomic } from "./dataset-io";

/**
 * Why a collection did not happen, or that it did.
 *
 * Re-exported from the domain types rather than declared here, so the quote the API
 * returns and the collector that produced it cannot drift apart.
 */
export type { OnDemandOutcome } from "../../scoring/types";

export interface QuotaState {
  /** ISO date the counter belongs to. */
  day: string;
  used: number;
}

export interface OnDemandOptions {
  datasetPath: string;
  adapter: CollectorAdapter | null;
  /** Requests allowed per calendar day across all cities. */
  dailyQuota: number;
  /** Re-collect only when the newest sample for the city is older than this. */
  freshHours: number;
  /** Where the quota counter lives. Defaults to `<datasetPath>.quota.json`. */
  quotaPath?: string;
  now: Date;
  log?: (message: string) => void;
  /** Injectable for tests: skips the real transport. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * How the ¥500 anchor is converted into the city's currency. Injectable so a test
   * does not reach the ECB — the suite is offline by design, and a network call hidden
   * inside a collection test would make it slow and flaky for reasons unrelated to what
   * it asserts.
   */
  resolveBaseline?: (currency: string, now: Date) => Promise<BaselineResult>;
}

export interface OnDemandResult {
  outcome: OnDemandOutcome;
  /** The dataset after a successful collection, else the one that was passed in. */
  dataset: HotelDataset;
}

const inflight = new Map<string, Promise<OnDemandResult>>();

/**
 * In-process fallback for a dataset that cannot be written to disk.
 *
 * Vercel gives a function only `/tmp`, which is per-instance and disappears with the
 * instance — so on a serverless deployment the dataset file does not exist and cannot be
 * created. Without this layer that breaks two things quietly and expensively:
 *
 *  - **Freshness is forgotten**, so every request for the city collects again. At one
 *    request per search, a busy hour spends the day's whole Hotelbeds quota.
 *  - **The request counter is forgotten**, which is the guard that exists to stop
 *    exactly that. It would fail open — the direction that costs money.
 *
 * Holding both in memory for the life of the process makes a warm instance behave like
 * the single-machine case. The honest caveats, which the CLI and the README state: this
 * is *per instance*, so N instances can each spend their own budget, and it is lost on a
 * cold start. A durable store (Vercel KV, Redis, Postgres) is the fix; until then the
 * daily quota should be set with the instance count in mind.
 */
const overlays = new Map<string, HotelDataset>();
const quotas = new Map<string, QuotaState>();

/** The newest dataset known for this path: disk, upgraded by anything collected since. */
function withOverlay(dataset: HotelDataset, datasetPath: string): HotelDataset {
  const overlay = overlays.get(datasetPath);
  if (!overlay) return dataset;
  // The overlay was merged from this dataset, so it is a superset; use it as-is.
  return overlay;
}

/** Remember a collection for later requests in this process. */
function rememberDataset(datasetPath: string, dataset: HotelDataset): void {
  overlays.set(datasetPath, dataset);
}

/** The higher of the disk counter and the in-memory one, when both are for today. */
function newestQuota(
  fromDisk: QuotaState,
  fromMemory: QuotaState | undefined,
  now: Date,
): QuotaState {
  const today = dayKey(now);
  if (fromMemory && fromMemory.day === today && fromMemory.used > fromDisk.used) {
    return fromMemory;
  }
  return fromDisk;
}

/**
 * The transport and robots cache, shared for the life of the process.
 *
 * Keyed on the injected fetch so a test that stubs the network does not inherit a
 * runtime built against the real one.
 */
let runtime: {
  fetchImpl: typeof globalThis.fetch | undefined;
  polite: ReturnType<typeof createPoliteFetch>;
  robots: RobotsCache;
} | null = null;

function sharedRuntime(
  fetchImpl: typeof globalThis.fetch | undefined,
  log: (message: string) => void,
) {
  if (runtime && runtime.fetchImpl === fetchImpl) return runtime;

  const polite = createPoliteFetch({
    ...(fetchImpl ? { underlying: fetchImpl } : {}),
    // A request path cannot wait for a crawl. Hotelbeds' own operation timeout is 5s.
    timeoutMs: 8_000,
    minIntervalMs: 0,
    maxRequests: 10_000,
    log: (line) => log(`  on-demand: ${line}`),
  });

  runtime = {
    fetchImpl,
    polite,
    robots: new RobotsCache(polite.fetchFn, USER_AGENT, (line) => log(`  ${line}`)),
  };
  return runtime;
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Reads the day's request count.
 *
 * A counter that resets on every deploy would be worse than none: it would let a
 * redeploy loop spend the whole quota. It is therefore a file, and an unreadable file
 * is treated as "quota already spent" — the safe direction, since guessing wrong means
 * a 403 for every later user that day.
 */
async function readQuota(path: string, now: Date): Promise<QuotaState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<QuotaState>;
    if (parsed.day === dayKey(now) && typeof parsed.used === "number") {
      return { day: parsed.day, used: parsed.used };
    }
    return { day: dayKey(now), used: 0 };
  } catch {
    return { day: dayKey(now), used: 0 };
  }
}

async function writeQuota(path: string, state: QuotaState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");
  } catch {
    // A counter we cannot persist is a counter we cannot trust; treat the quota as
    // spent by pushing it to the limit.
    throw new Error("quota counter is not writable");
  }
}

/** Newest `collectedAt` among a city's samples, or null when it has none. */
function newestSampleFor(dataset: HotelDataset, cityId: string): string | null {
  const census = dataset.cities.find((c) => c.cityId === cityId);
  if (!census) return null;
  const ids = new Set(census.properties.map((p) => p.id));
  let newest: string | null = null;
  for (const sample of dataset.samples) {
    if (!ids.has(sample.propertyId)) continue;
    if (newest === null || sample.collectedAt > newest) newest = sample.collectedAt;
  }
  return newest;
}

/** Does the city already have samples near `date`? */
function coversWindow(dataset: HotelDataset, cityId: string, date: string, windowDays = 3): boolean {
  const census = dataset.cities.find((c) => c.cityId === cityId);
  if (!census) return false;
  const ids = new Set(census.properties.map((p) => p.id));
  const from = addDays(date, -windowDays);
  const to = addDays(date, windowDays);
  return dataset.samples.some(
    (sample) =>
      ids.has(sample.propertyId) && sample.date >= from && sample.date <= to,
  );
}

function isFresh(dataset: HotelDataset, cityId: string, date: string, now: Date, freshHours: number): boolean {
  if (!coversWindow(dataset, cityId, date)) return false;
  const newest = newestSampleFor(dataset, cityId);
  if (newest === null) return false;
  const ageHours = (now.getTime() - new Date(newest).getTime()) / 3_600_000;
  // A clock skew that makes a sample look like it came from the future must not read as
  // "fresh forever"; anything not clearly within the window is re-collected.
  return ageHours >= 0 && ageHours < freshHours;
}

/**
 * Collects one city-night if it is worth doing, and returns the dataset to use.
 *
 * Never throws. The result says what happened so the caller can disclose it, and the
 * dataset it returns is always safe to read.
 */
export async function collectCityOnDemand(
  city: City,
  date: string,
  dataset: HotelDataset,
  options: OnDemandOptions,
): Promise<OnDemandResult> {
  const log = options.log ?? (() => {});

  const adapter = options.adapter;
  const fetchRates = adapter?.fetchRates;
  if (!adapter || !fetchRates) {
    return {
      outcome: { status: "skipped", reason: "no price source is configured" },
      dataset,
    };
  }

  dataset = withOverlay(dataset, options.datasetPath);

  if (isFresh(dataset, city.id, date, options.now, options.freshHours)) {
    return { outcome: { status: "fresh" }, dataset };
  }

  const key = `${city.id}|${date}`;
  const running = inflight.get(key);
  if (running) return running;

  const run = (async (): Promise<OnDemandResult> => {
    const quotaPath = options.quotaPath ?? `${options.datasetPath}.quota.json`;

    let quota: QuotaState;
    try {
      quota = newestQuota(
        await readQuota(quotaPath, options.now),
        quotas.get(quotaPath),
        options.now,
      );
    } catch (error) {
      return {
        outcome: { status: "skipped", reason: String(error) },
        dataset,
      };
    }

    if (quota.used >= options.dailyQuota) {
      log(
        `on-demand collection: daily budget of ${options.dailyQuota} requests is spent`,
      );
      return {
        outcome: {
          status: "skipped",
          reason: `the daily collection budget of ${options.dailyQuota} requests is spent`,
        },
        dataset,
      };
    }

    /**
     * The scoring anchor has to exist before the prices do: `baselineLocal` is the ¥500
     * the median is compared against, and a dataset row without a positive baseline is
     * rejected by validation. Resolved here — before spending a request — so a currency
     * the FX module cannot convert fails fast and costs nothing.
     */
    const existingCensus = dataset.cities.find((c) => c.cityId === city.id);
    let baseline = existingCensus?.baselineLocal ?? 0;
    let baselineAsOf = existingCensus?.baselineAsOf ?? options.now.toISOString();
    let baselineSource = existingCensus ? "kept from the existing census" : "";

    if (!(baseline > 0)) {
      const resolveBaseline = options.resolveBaseline ?? baselineForCurrency;
      const converted = await resolveBaseline(city.currency, options.now);
      if (!converted.ok) {
        return {
          outcome: { status: "failed", reason: `no ¥500 anchor for ${city.currency}: ${converted.detail}` },
          dataset,
        };
      }
      baseline = converted.data.baselineLocal;
      baselineAsOf = converted.data.asOf;
      baselineSource = `anchor ¥500 via ${converted.data.source}`;
    }

    /**
     * One request per city-night, through a process-wide transport.
     *
     * The transport is shared rather than built per call so that `robots.txt` is fetched
     * once per process instead of once per collection — on a 50-request daily budget,
     * paying a robots request for every city halves how many cities can be covered.
     * The real limit is the on-disk counter below, so the transport's own budget is
     * generous and the spend is measured as a delta around this call.
     */
    const runtime = sharedRuntime(options.fetchImpl, log);
    const before = runtime.polite.requestsMade();

    const ctx = {
      fetchFn: runtime.polite.fetchFn,
      robots: runtime.robots.gate(),
      now: options.now,
      log: (line: string) => log(line),
    };

    let rates: RawRate[] = [];
    try {
      const outcome = await fetchRates.call(adapter, [{ cityId: city.id, date }], ctx);
      if (!outcome.ok) {
        return {
          outcome: { status: "failed", reason: describe(outcome.failure) },
          dataset,
        };
      }
      rates = outcome.data;
    } catch (error) {
      // Includes BudgetExhaustedError: the answer is a reason, not an exception.
      return {
        outcome: { status: "failed", reason: String(error) },
        dataset,
      };
    } finally {
      /**
       * Charge the budget for what was actually sent, and never less than one request
       * for a fetch that returned prices.
       *
       * The floor matters: the transport counts what *it* sent, so an adapter using its
       * own HTTP client would look free, and a source that always looks free is a source
       * that spends the day's quota without the counter noticing. A successful rate fetch
       * is by definition at least one request.
       *
       * A failed attempt with no requests sent — refused by robots.txt, no anchor, a
       * misconfigured source — costs nothing, because nothing was spent.
       */
      const spent = Math.max(
        runtime.polite.requestsMade() - before,
        rates.length > 0 ? 1 : 0,
      );
      const next: QuotaState = { day: quota.day, used: quota.used + spent };
      /**
       * Always record it in memory first. A deployment whose filesystem is read-only
       * must still count what it spends — a counter that fails open is worse than no
       * counter, because it keeps collecting while believing it has budget.
       */
      quotas.set(quotaPath, next);
      try {
        await writeQuota(quotaPath, next);
      } catch (error) {
        log(
          `on-demand collection: ${String(error)} — counting in memory for this instance only`,
        );
      }
    }

    if (rates.length === 0) {
      return { outcome: { status: "failed", reason: "no rates returned" }, dataset };
    }

    const merged = mergeRates(dataset, city, date, rates, {
      now: options.now,
      baselineLocal: baseline,
      baselineAsOf,
      baselineSource,
      /**
       * The disclosure the *source* asks for, which the CLI takes from the same place.
       *
       * Missing this was a real bug, found by running the serverless configuration: a
       * dataset built purely by on-demand collection fell through to the schema's
       * `price` default, so a source that permits publishing only an index would have
       * had its amounts published — the exact disclosure the index mode exists to
       * withhold. The merge takes the most restrictive of the two, so an existing
       * `index` dataset is never loosened either.
       */
      disclosure: adapter.defaultDisclosure,
    });

    /**
     * Keep it in memory regardless of the disk: that is what makes the freshness window
     * work on a deployment whose filesystem is read-only, instead of re-collecting the
     * same city on every request.
     */
    rememberDataset(options.datasetPath, merged);

    try {
      await writeDatasetAtomic(options.datasetPath, merged);
    } catch (error) {
      /**
       * A read-only filesystem is a deployment fact, not a failure of this collection:
       * the prices were fetched and are being served, and this process will remember
       * them. Logged rather than reported, because the user's score is correct.
       */
      log(
        `on-demand collection: ${String(error)} — serving ${rates.length} prices from memory for this instance`,
      );
    }

    const properties = merged.cities.find((c) => c.cityId === city.id)?.properties.length;
    log(
      `on-demand collection: ${city.id} ${date} -> ${rates.length} prices (${properties ?? 0} properties known)`,
    );
    return {
      outcome: { status: "collected", properties: rates.length },
      dataset: merged,
    };
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

export interface MergeContext {
  now: Date;
  /** The ¥500 anchor in the city's currency, already resolved. */
  baselineLocal: number;
  baselineAsOf: string;
  baselineSource: string;
  /** What the source permits publishing; the stricter value wins in the merge. */
  disclosure?: HotelDisclosure;
}

/** Folds fresh rates into the dataset as a one-city collection. */
export function mergeRates(
  dataset: HotelDataset,
  city: City,
  date: string,
  rates: RawRate[],
  context: MergeContext,
): HotelDataset {
  const existing = dataset.cities.find((c) => c.cityId === city.id);
  const properties: HotelProperty[] = [...(existing?.properties ?? [])];
  const known = new Set(properties.map((p) => p.id));

  for (const rate of rates) {
    if (known.has(rate.propertyId)) continue;
    known.add(rate.propertyId);
    properties.push({
      id: rate.propertyId,
      name: rate.propertyId,
      group: rate.source,
    });
  }

  const samples: HotelPriceSample[] = rates.map((rate) => ({
    date: rate.date,
    propertyId: rate.propertyId,
    priceLocal: rate.priceLocal,
    source: rate.source,
    collectedAt: rate.collectedAt,
    extraction: rate.extraction,
    ...(rate.note ? { note: rate.note } : {}),
  }));

  const census = {
    cityId: city.id,
    currency: city.currency,
    baselineLocal: context.baselineLocal,
    baselineAsOf: context.baselineAsOf,
    properties,
    /**
     * An availability search returns the hotels that have a room to sell, not the
     * city's inventory, so coverage is never claimed for a city collected this way.
     */
    censusComplete: false,
    censusSource: existing?.censusSource ?? "on-demand:hotelbeds",
    notes: context.baselineSource || existing?.notes,
  };

  return mergeDataset(dataset, {
    cities: [census],
    samples,
    generatedAt: context.now.toISOString(),
    basis: dataset.basis ?? { ...DEFAULT_BASIS },
    ...(context.disclosure ? { disclosure: context.disclosure } : {}),
  });
}

function describe(failure: { kind: string } & Record<string, unknown>): string {
  switch (failure.kind) {
    case "blocked":
      return `blocked by ${String(failure.by)}`;
    case "robots-disallowed":
      return `refused by robots.txt: ${String(failure.rule)}`;
    case "skipped":
      return String(failure.reason);
    case "parse-error":
    case "no-endpoint":
    case "unverified-shape":
      return String(failure.detail);
    case "http-error":
      return `HTTP ${String(failure.status)}`;
    default:
      return failure.kind;
  }
}

/** Exposed for tests. */
export const internals = {
  isFresh,
  coversWindow,
  newestSampleFor,
  reduceToPropertyMedians,
  withOverlay,
  /** Test seam: the per-process overlay would otherwise leak between test cases. */
  resetMemory(): void {
    overlays.clear();
    quotas.clear();
  },
};
