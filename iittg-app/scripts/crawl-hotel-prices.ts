/**
 * Hotel price collection CLI.
 *
 * The offline job that builds `data/hotel-prices.json`, which the app reads when
 * `IITTG_HOTEL_SOURCE=self-collected`. It is deliberately not a route handler or a
 * server action: collection is minutes of paced HTTP, and putting it on a request
 * path would make the score depend on a crawl.
 *
 * Usage:
 *   node scripts/crawl-hotel-prices.ts --cities tokyo,osaka --dates 2026-10-20,2026-10-21
 *   node scripts/crawl-hotel-prices.ts --census census.csv --import rates.csv --out data/hotel-prices.json
 *
 * Flags:
 *   --cities <ids>        Comma-separated city ids; default: every configured city.
 *   --dates <iso,...>     Check-in dates to price; default: today +7 and +14 days.
 *   --import <file.csv>   Prices collected elsewhere (partner feed, manual run).
 *   --census <file.csv>   A city's *complete* property list; makes coverage real.
 *   --out <file>          Where to write the dataset. Default: data/hotel-prices.json
 *   --no-write            Report only; useful with --import to validate a file.
 *   --max-properties <n>  Cap properties priced per city, for a cheap first run.
 *   --max-requests <n>    Transport request budget. Default 400.
 *   --session <file>      JSON `{ "cookies": "...", "headers": {...} }` for sources
 *                         that refuse anonymous clients. Never obtained for you.
 *   --user-agent <ua>     Override the collector's identity. Please do not.
 *
 * Requires Node 22.18+ (`node file.ts` strips types); no build step.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CITIES, findCity } from "../src/lib/data/cities";
import { validateDataset } from "../src/lib/data/hotel-dataset";
import { createFileStore } from "../src/lib/data/hotel-dataset-file";
import { computeCityReferencePrice, MIN_PROPERTIES } from "../src/lib/data/hotel-price";
import { createPoliteFetch, USER_AGENT, DEFAULT_MAX_REQUESTS } from "../src/lib/data/collect/http";
import { RobotsCache } from "../src/lib/data/collect/robots";
import { runCollection, type ImportedInput } from "../src/lib/data/collect/run";
import {
  censusFromCsv,
  ratesFromCsv,
  ratesFromJson,
} from "../src/lib/data/collect/import";
import { quantile } from "../src/lib/data/hotel-dataset";
import { createHotelbedsAdapter } from "../src/lib/data/collect/adapters/hotelbeds";
import { getHotelbedsCredentials } from "../src/lib/data/config";
import type { HotelDisclosure } from "../src/lib/data/hotel-dataset";
import {
  createHttpJsonAdapter,
  parseSourceConfig,
} from "../src/lib/data/collect/adapters/http-json";
import type {
  BrowserSession,
  CollectorAdapter,
  CollectorContext,
} from "../src/lib/data/collect/types";

/* ------------------------------------------------------------------- args */

interface Args {
  cities: string[];
  dates: string[];
  importFiles: string[];
  censusFiles: string[];
  sourceConfigs: string[];
  out: string;
  write: boolean;
  maxProperties?: number;
  maxRequests: number;
  session?: string;
  userAgent: string;
  disclosure?: HotelDisclosure;
  noHotelbeds: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cities: [],
    dates: [],
    importFiles: [],
    censusFiles: [],
    sourceConfigs: [],
    out: "data/hotel-prices.json",
    write: true,
    maxRequests: DEFAULT_MAX_REQUESTS,
    userAgent: USER_AGENT,
    noHotelbeds: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const take = () => {
      i += 1;
      return value;
    };
    switch (flag) {
      case "--cities":
        args.cities = take().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--dates":
        args.dates = take().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--import":
        args.importFiles.push(take());
        break;
      case "--census":
        args.censusFiles.push(take());
        break;
      case "--source":
        args.sourceConfigs.push(take());
        break;
      case "--out":
        args.out = take();
        break;
      case "--no-write":
        args.write = false;
        break;
      case "--max-properties":
        args.maxProperties = Number.parseInt(take(), 10);
        break;
      case "--max-requests":
        args.maxRequests = Number.parseInt(take(), 10);
        break;
      case "--session":
        args.session = take();
        break;
      case "--user-agent":
        args.userAgent = take();
        break;
      case "--disclosure": {
        const value = take();
        if (value !== "price" && value !== "index") {
          throw new Error('--disclosure must be "price" or "index"');
        }
        args.disclosure = value;
        break;
      }
      case "--no-hotelbeds":
        args.noHotelbeds = true;
        break;
      default:
        if (flag.startsWith("--")) {
          throw new Error(`Unknown flag: ${flag}`);
        }
    }
  }

  return args;
}

/* ------------------------------------------------------------ assembling */

async function loadSession(path: string | undefined): Promise<BrowserSession | undefined> {
  if (!path) return undefined;
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BrowserSession>;
  if (typeof parsed.cookies !== "string" || parsed.cookies === "") {
    throw new Error(`${path}: expected { "cookies": "name=value; ..." }`);
  }
  return { cookies: parsed.cookies, headers: parsed.headers };
}

async function loadAdapters(args: Args): Promise<CollectorAdapter[]> {
  const adapters: CollectorAdapter[] = [];

  /**
   * Hotelbeds is the city-wide price source: one request returns the hotels with
   * availability around a city centre, which is the breadth a median needs. Without
   * credentials the collector still runs — it just cannot price anything, and says
   * so rather than pretending.
   */
  const hotelbeds = args.noHotelbeds ? null : getHotelbedsCredentials();
  if (hotelbeds) {
    adapters.push(createHotelbedsAdapter(hotelbeds));
  } else if (!args.noHotelbeds) {
    console.log(
      "\n  note: no IITTG_HOTELBEDS_API_KEY/SECRET, so no price source is configured.",
    );
    console.log(
      "        Register free at developer.hotelbeds.com (50 requests/day), or pass",
    );
    console.log("        --import with prices collected elsewhere.");
  }
  for (const path of args.sourceConfigs) {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const [index, entry] of entries.entries()) {
      const result = parseSourceConfig(entry, `${path}[${index}]`);
      if (!result.ok) throw new Error(result.errors.join("\n"));
      adapters.push(createHttpJsonAdapter(result.config));
    }
  }
  return adapters;
}

async function loadImports(
  args: Args,
  currencyByCity: Map<string, string>,
): Promise<ImportedInput> {
  const input: ImportedInput = {
    samples: [],
    propertiesByCity: new Map(),
    completeCities: new Set(),
    sources: [],
  };
  const problems: string[] = [];

  for (const path of args.censusFiles) {
    const text = await readFile(path, "utf8");
    const parsed = path.endsWith(".json")
      ? censusFromCsv(text, path) // JSON census uses the same shape; CSV is the norm
      : censusFromCsv(text, path);
    problems.push(...parsed.errors);
    for (const [cityId, properties] of parsed.propertiesByCity) {
      const existing = input.propertiesByCity.get(cityId) ?? [];
      const seen = new Set(existing.map((p) => p.id));
      input.propertiesByCity.set(
        cityId,
        existing.concat(properties.filter((p) => !seen.has(p.id))),
      );
      // A supplied census is taken as the city's complete inventory — that is what
      // makes a coverage percentage mean anything.
      input.completeCities.add(cityId);
    }
    input.sources.push(path);
  }

  for (const path of args.importFiles) {
    const text = await readFile(path, "utf8");
    const parsed = path.endsWith(".json")
      ? ratesFromJson(text, path)
      : ratesFromCsv(text, path, { currencyByCity });
    problems.push(...parsed.errors);
    input.samples.push(...parsed.samples);
    for (const [cityId, properties] of parsed.propertiesByCity) {
      const existing = input.propertiesByCity.get(cityId) ?? [];
      const seen = new Set(existing.map((p) => p.id));
      input.propertiesByCity.set(
        cityId,
        existing.concat(properties.filter((p) => !seen.has(p.id))),
      );
    }
    input.sources.push(path);
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} row(s) rejected while reading input files:`);
    for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
    if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  }

  return input;
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const cities =
    args.cities.length > 0
      ? args.cities.map((id) => {
          const city = findCity(id);
          if (!city) throw new Error(`Unknown city id: ${id}`);
          return city;
        })
      : CITIES;

  const now = new Date();
  const dates =
    args.dates.length > 0
      ? args.dates
      : [7, 14].map((offset) => {
          const d = new Date(now.getTime() + offset * 86_400_000);
          return d.toISOString().slice(0, 10);
        });

  const currencyByCity = new Map(cities.map((city) => [city.id, city.currency]));
  const session = await loadSession(args.session);
  const adapters = await loadAdapters(args);
  const imported = await loadImports(args, currencyByCity);

  const polite = createPoliteFetch({
    userAgent: args.userAgent,
    maxRequests: args.maxRequests,
    log: (line) => console.log(line),
  });
  const robots = new RobotsCache(polite.fetchFn, args.userAgent, (line) =>
    console.log(`  ${line}`),
  );

  const context: CollectorContext = {
    fetchFn: polite.fetchFn,
    robots: robots.gate(),
    ...(session ? { session } : {}),
    now,
    log: (line) => console.log(line),
    requestsMade: polite.requestsMade,
  };

  console.log(`\nCollecting hotel prices`);
  console.log(`  cities:      ${cities.map((c) => c.id).join(", ")}`);
  console.log(`  dates:       ${dates.join(", ")}`);
  console.log(`  adapters:    ${adapters.map((a) => a.name).join(", ") || "none"}`);
  console.log(`  imports:     ${imported.sources.join(", ") || "none"}`);
  console.log(`  budget:      ${args.maxRequests} requests\n`);

  const report = await runCollection({
    cities,
    dates,
    adapters,
    context,
    imported,
    ...(args.maxProperties ? { maxPropertiesPerCity: args.maxProperties } : {}),
    ...(args.disclosure ? { disclosure: args.disclosure } : {}),
  });

  /* ------------------------------------------------------------- report */

  console.log(`\n${"city".padEnd(14)}${"props".padEnd(7)}${"census".padEnd(9)}${"prices".padEnd(8)}${"median".padEnd(12)}sources`);
  for (const city of report.cities) {
    // A partial census has no denominator, which is why the app then declines to
    // claim what fraction of the city the median saw.
    const censusLabel = city.censusComplete ? "listed" : "partial";
    console.log(
      `${city.cityId.padEnd(14)}${String(city.properties).padEnd(7)}${censusLabel.padEnd(9)}${String(city.samples).padEnd(8)}${(city.medianLocal ?? "-").toString().padEnd(12)}${city.sources.join(",")}`,
    );
    for (const failure of city.failures) {
      console.log(`${" ".repeat(14)}  ! ${failure}`);
    }

    /**
     * The spread, not just the median.
     *
     * A median is robust to a bad rate, which is the point of using one — but that
     * also means a source returning an absurd amount (the evaluation inventory has
     * one: a 3.5-star in Osaka quoting €5,374 for a night) leaves no trace in the
     * number the operator sees. Printing the quartiles and the extremes makes the
     * difference between "the market is wide" and "one hotel is broken" visible.
     */
    const ids = new Set(report.dataset.cities.find((c) => c.cityId === city.cityId)?.properties.map((p) => p.id) ?? []);
    const prices = report.dataset.samples
      .filter((sample) => ids.has(sample.propertyId))
      .map((sample) => sample.priceLocal);
    if (prices.length >= 4) {
      console.log(
        `${" ".repeat(14)}  spread p25=${Math.round(quantile(prices, 0.25))} median=${Math.round(quantile(prices, 0.5))} p75=${Math.round(quantile(prices, 0.75))} min=${Math.round(Math.min(...prices))} max=${Math.round(Math.max(...prices))}`,
      );
      const medianPrice = quantile(prices, 0.5);
      const extreme = Math.max(...prices);
      if (medianPrice > 0 && extreme > medianPrice * 5) {
        console.log(
          `${" ".repeat(14)}  ! an outlier is ${(extreme / medianPrice).toFixed(1)}x the median — check the source, the median is unaffected`,
        );
      }
    }
  }

  if (report.dropped.length > 0) {
    console.log(`\n${report.dropped.length} sample(s) discarded:`);
    for (const line of report.dropped.slice(0, 20)) console.log(`  - ${line}`);
    if (report.dropped.length > 20) {
      console.log(`  ... and ${report.dropped.length - 20} more`);
    }
  }

  console.log(`\nrequests made: ${report.requestsMade}`);
  console.log(
    `disclosure:   ${report.disclosure}${report.disclosure === "index" ? " (the app publishes the distance from the ¥500 anchor, not the amount)" : " (the app publishes the median nightly rate)"}`,
  );

  /* -------------------------------------------------- read-side preview */

  console.log(
    `\nReference price as the app will serve it (needs ${MIN_PROPERTIES}+ properties):`,
  );
  for (const census of report.dataset.cities) {
    for (const date of dates.slice(0, 1)) {
      const { quote } = computeCityReferencePrice(
        census,
        report.dataset.samples,
        date,
        now,
        report.disclosure,
      );
      const coverage =
        quote.propertyUniverse && quote.propertyUniverse > 0
          ? ` of ${quote.propertyUniverse} listed`
          : "";
      const amount =
        report.disclosure === "index"
          ? `${Math.round((quote.perNightLocal / quote.baselineLocal - 1) * 1000) / 10}% vs the anchor`
          : `${quote.perNightLocal} ${census.currency}`;
      const status =
        quote.sampleSize === 0
          ? "unavailable (hotel dimension excluded)"
          : `${amount}, ${quote.sampleSize} properties${coverage}, confidence ${quote.confidence}${quote.stale ? ", STALE" : ""}`;
      console.log(`  ${census.cityId.padEnd(14)} ${date}  ${status}`);
    }
  }

  /* ------------------------------------------------------------- output */

  const validation = validateDataset(report.dataset);
  if (!validation.ok) {
    console.error(`\nInternal error: produced dataset is invalid:`);
    for (const error of validation.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  if (!args.write) {
    console.log("\n--no-write: dataset not saved.");
    return;
  }

  const outPath = resolve(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report.dataset, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${outPath}`);
  console.log(
    `  ${report.dataset.cities.length} cities, ${report.dataset.samples.length} samples, version ${report.dataset.version}`,
  );

  // Read it back through the same store the app uses, so a dataset that passes
  // validation but cannot be served is caught here rather than in production.
  const store = createFileStore(outPath, { strict: true, verbose: true });
  const reloaded = await store.load();
  console.log(
    `  reloaded through the app's store: ${reloaded.cities.length} cities, ${reloaded.samples.length} samples`,
  );
  console.log(
    `\nEnable it with: IITTG_HOTEL_SOURCE=self-collected IITTG_HOTEL_DATASET=${outPath}`,
  );
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
