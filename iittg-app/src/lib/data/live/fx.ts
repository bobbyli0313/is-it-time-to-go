/**
 * Live exchange rates via Frankfurter (api.frankfurter.dev), which serves the
 * European Central Bank's daily reference rates with no API key.
 *
 * The FX dimension needs two things: today's rate, and the rate's position within
 * its own trailing 12-month range. Frankfurter provides both as a time series, so
 * the range is measured from real daily observations rather than assumed.
 *
 * ## The coverage limitation, and why it is handled by falling back rather than by
 * ## adding a second upstream
 *
 * Frankfurter carries the ECB basket: 30 currencies. That covers CNY, JPY, KRW,
 * THB, SGD, MYR, IDR, PHP and HKD — everything in the launch scope except TWD and
 * VND, which the ECB does not publish.
 *
 * A second upstream (open.er-api.com) does cover them, and was measured working.
 * It is deliberately not used: it is an aggregator whose commercial terms are
 * unclear, and the FX dimension is a minor score component for exactly two of the
 * eleven currencies involved. Instead, unsupported pairs fall back to the curated
 * static table and the result is tagged `source: "static-reference"`, which the UI
 * discloses. An honest, slightly stale answer beats an unclear licence.
 */

import type { City, FxSnapshot } from "../../scoring/types";
import { FX_VS_CNY } from "../reference";
import { TTL, remember } from "../cache";
import { fetchJson } from "../http";

const BASE_URL = "https://api.frankfurter.dev/v1";

/**
 * The ECB basket, verified against `/v1/currencies`. Used to decide ahead of the
 * request whether a pair is serviceable, so an unsupported pair does not cost a
 * round trip that is certain to fail.
 */
export const ECB_CURRENCIES = new Set([
  "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD",
  "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK",
  "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

/**
 * Where a rate and its range came from. Surfaced to the UI, so the distinction
 * between "a real rate from the static table" and "sample data" has to be explicit.
 */
export type FxSource = "ecb-daily" | "static-reference" | "mock";

export interface FxResult {
  snapshot: FxSnapshot;
  source: FxSource;
}

export class FxUpstreamError extends Error {
  /**
   * Declared rather than written as a parameter property: the collector CLI runs
   * this module through Node's strip-only TypeScript support, which rejects that
   * syntax. See `scripts/ts-loader.mjs`.
   */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "FxUpstreamError";
    this.status = status;
  }
}

interface TimeSeriesResponse {
  base?: string;
  start_date?: string;
  end_date?: string;
  rates?: Record<string, Record<string, number>>;
}

function isoDaysAgo(days: number, now: Date): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

interface Series {
  /** Ascending by date. */
  points: Array<{ date: string; rate: number }>;
}

/**
 * Daily {from}->{to} observations over the trailing year.
 *
 * Frankfurter omits weekends and holidays rather than forward-filling, which is
 * what we want: a rate is not "observed" on a day the ECB does not publish.
 */
async function fetchYearSeries(
  from: string,
  to: string,
  now: Date,
): Promise<Series> {
  const start = isoDaysAgo(365, now);
  const end = now.toISOString().slice(0, 10);
  const key = `fx:series:${from}:${to}:${end}`;

  const raw = await remember(
    key,
    async () => {
      const url = `${BASE_URL}/${start}..${end}?base=${from}&symbols=${to}`;
      const body = await fetchJson<TimeSeriesResponse>(url, {
        timeoutMs: 8_000,
        attempts: 3,
      });
      if (!body) throw new FxUpstreamError("Frankfurter returned nothing");
      return body;
    },
    { ttlMs: TTL.fxYearRange, staleOnError: true },
  );

  const rates = raw.rates ?? {};
  const points = Object.entries(rates)
    .map(([date, perCurrency]) => ({ date, rate: perCurrency[to] }))
    .filter((p) => Number.isFinite(p.rate))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  if (points.length === 0) {
    throw new FxUpstreamError(`No observations for ${from}->${to}`);
  }

  return { points };
}

/** Curated fallback for pairs the ECB does not publish. */
function staticReference(
  from: string,
  to: string,
  now: Date,
): FxResult | null {
  // The table is anchored on CNY, so cross-convert through it.
  const fromRef = FX_VS_CNY[from];
  const toRef = FX_VS_CNY[to];
  if (!fromRef || !toRef) return null;

  // CNY -> X is the table's native direction.
  const fromPerCny = from === "CNY" ? 1 : fromRef.cnyToQuote;
  const toPerCny = to === "CNY" ? 1 : toRef.cnyToQuote;

  const current = toPerCny / fromPerCny;
  const low = toRef.yearLow / fromRef.yearHigh;
  const high = toRef.yearHigh / fromRef.yearLow;

  return {
    source: "static-reference",
    snapshot: {
      from,
      to,
      rate: round6(current),
      yearLow: round6(Math.min(low, high)),
      yearHigh: round6(Math.max(low, high)),
      asOf: now.toISOString(),
    },
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Resolves the rate and its trailing 12-month range for a city pair.
 *
 * Returns `null` for same-currency trips, which is a legitimate "not applicable"
 * rather than a failure.
 */
export async function fetchLiveFx(
  origin: City,
  destination: City,
  now: Date = new Date(),
): Promise<FxResult | null> {
  if (origin.currency === destination.currency) return null;

  const from = origin.currency;
  const to = destination.currency;

  const serviceable = ECB_CURRENCIES.has(from) && ECB_CURRENCIES.has(to);
  if (!serviceable) {
    const fallback = staticReference(from, to, now);
    if (fallback) return fallback;
    throw new FxUpstreamError(
      `No rate available for ${from}->${to}: not in the ECB basket and not in the static reference table`,
    );
  }

  let series: Series;
  try {
    series = await fetchYearSeries(from, to, now);
  } catch (error) {
    /**
     * Degrade rather than fail the whole score. A pair the ECB publishes can still
     * be answered from the curated table, and the result is labelled
     * `static-reference` so the UI discloses it. Losing one dimension's freshness is
     * a far better outcome than losing the score.
     */
    const fallback = staticReference(from, to, now);
    if (fallback) return fallback;
    throw error;
  }

  const rates = series.points.map((p) => p.rate);
  const latest = series.points[series.points.length - 1];

  return {
    source: "ecb-daily",
    snapshot: {
      from,
      to,
      rate: round6(latest.rate),
      yearLow: round6(Math.min(...rates)),
      yearHigh: round6(Math.max(...rates)),
      // The observation date, not the request time: the ECB publishes on working
      // days, so a weekend request legitimately returns Friday's rate.
      asOf: new Date(`${latest.date}T00:00:00Z`).toISOString(),
    },
  };
}

/** Exported for tests. */
export const internals = {
  staticReference,
  usdRateTo,
  round6,
  isoDaysAgo,
};

/**
 * USD -> `to` rate, for unit conversion rather than scoring.
 *
 * The distance model's anchor is denominated in USD (`miles x $0.10`), so any fare in
 * another currency has to be converted before the two can be compared. This was a real
 * bug: a CNY fare of 3,009 was divided by a USD anchor of 218 and scored as though the
 * route cost 13.8x the theoretical price, when the true ratio was about 2x.
 *
 * Returns `null` when the pair is not serviceable, so the caller can decline to score
 * rather than invent a rate.
 */
export async function usdRateTo(
  to: string,
  now: Date = new Date(),
): Promise<number | null> {
  if (to === "USD") return 1;

  /**
   * Currencies outside the ECB basket (TWD, VND) fall back to the curated table, for
   * consistency with the FX *dimension*, which already scores those pairs from the same
   * table and discloses it. Without this the two disagreed: a TWD trip got a scoring
   * exchange rate but no anchor conversion, so its flight dimension was excluded for a
   * reason the user could not see.
   */
  if (!ECB_CURRENCIES.has(to)) {
    const ref = FX_VS_CNY[to];
    if (!ref || ref.cnyToQuote <= 0) return null;
    const usdRef = FX_VS_CNY.USD;
    if (!usdRef || usdRef.cnyToQuote <= 0) return null;
    // CNY per unit of `to`, divided by CNY per USD.
    return ref.cnyToQuote / usdRef.cnyToQuote;
  }

  try {
    // Longer TTL than the scoring path: a unit conversion does not need same-day
    // precision, and this keeps the conversion off the critical path after the first
    // call for a currency.
    const series = await remember(
      `fx:usd-rate:${to}:${now.toISOString().slice(0, 10)}`,
      () => fetchYearSeries("USD", to, now),
      { ttlMs: TTL.fxYearRange, staleOnError: true },
    );
    const latest = series.points[series.points.length - 1];
    return Number.isFinite(latest?.rate) && latest.rate > 0 ? latest.rate : null;
  } catch {
    return null;
  }
}
