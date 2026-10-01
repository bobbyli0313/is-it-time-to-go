/**
 * Guards the contract between the scoring model and the UI.
 *
 * The scorers emit i18n *keys*, not prose. Nothing in the type system forces a
 * newly invented key to exist in the dictionaries, so without this test a typo
 * like `crowd.driver.peakRun` vs `crowd.driver.peakRuns` would silently render
 * as a raw key in production. This walks every scorer across every branch and
 * asserts each emitted key resolves in every locale.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MESSAGES, LOCALES, translate, type Locale } from "@/lib/i18n";
import {
  scoreCrowd,
  scoreFlight,
  scoreFx,
  scoreHotel,
  scoreTrip,
  scoreWeather,
} from "@/lib/scoring";
import type {
  City,
  DimensionScore,
  FxSnapshot,
  Holiday,
  HotelQuote,
  TripInput,
  WeatherSample,
} from "@/lib/scoring/types";

const NOW = new Date("2026-09-22T04:00:00Z");

const PVG: City = {
  id: "shanghai",
  iataCity: "SHA",
  airports: ["PVG", "SHA"],
  country: "CN",
  currency: "CNY",
  timezone: "Asia/Shanghai",
  lat: 31.2304,
  lon: 121.4737,
  name: { en: "Shanghai", zh: "上海" },
};

const HND: City = {
  id: "tokyo",
  iataCity: "TYO",
  airports: ["HND", "NRT"],
  country: "JP",
  currency: "JPY",
  timezone: "Asia/Tokyo",
  lat: 35.6762,
  lon: 139.6503,
  name: { en: "Tokyo", zh: "东京" },
};

const TRIP: TripInput = {
  origin: PVG,
  destination: HND,
  departDate: "2026-09-25",
  returnDate: "2026-09-29",
};

function existsInEveryLocale(key: string): boolean {
  return LOCALES.every((locale: Locale) => {
    const table = MESSAGES[locale] as Record<string, string>;
    return table[key] !== undefined;
  });
}

/**
 * Every dimension any scorer can produce, gathered by exercising every branch.
 *
 * Both the driver keys and the *fact keys* are asserted against the dictionary, so
 * the walker returns the finished dimensions rather than the keys it happens to be
 * interested in.
 */
function collectDimensions(): DimensionScore[] {
  const dimensions: DimensionScore[] = [];

  const weatherSamples: WeatherSample[] = [
    // Ideal forecast.
    { date: "2026-09-25", basis: "forecast", tempC: 25, humidityPct: 50, tempSpreadC: 2, humiditySpreadPct: 8 },
    // Hot and humid.
    { date: "2026-09-25", basis: "forecast", tempC: 36, humidityPct: 88, tempSpreadC: 2, humiditySpreadPct: 8 },
    // Cold and dry.
    { date: "2026-09-25", basis: "forecast", tempC: 8, humidityPct: 22, tempSpreadC: 2, humiditySpreadPct: 8 },
    // Climate normal, near and far.
    { date: "2026-10-20", basis: "climate-normal", tempC: 25, humidityPct: 50, tempSpreadC: 6, humiditySpreadPct: 18 },
    { date: "2026-12-20", basis: "climate-normal", tempC: 4, humidityPct: 40, tempSpreadC: 6, humiditySpreadPct: 18 },
  ];
  for (const sample of weatherSamples) {
    dimensions.push(scoreWeather(sample, TRIP, NOW));
  }

  const hotelQuotes: HotelQuote[] = [
    { perNightLocal: 300, baselineLocal: 500, confidence: 0.8, basis: "collected-median", sampleSize: 20 },
    { perNightLocal: 700, baselineLocal: 500, confidence: 0.8, basis: "collected-median", sampleSize: 20 },
    { perNightLocal: 1000, baselineLocal: 500, confidence: 0.8, basis: "collected-median", sampleSize: 20 },
    { perNightLocal: 2600, baselineLocal: 500, confidence: 0.8, basis: "collected-median", sampleSize: 3 },
    { perNightLocal: 800, baselineLocal: 500, confidence: 0.4, basis: "mock-flat", sampleSize: 3 },
    // A destination the collector has not covered: excluded, never scored as cheap.
    {
      perNightLocal: 0,
      baselineLocal: 0,
      confidence: 0,
      basis: "collected-median",
      sampleSize: 0,
    },
    // A collected median with full disclosure, and a stale one.
    {
      perNightLocal: 12_000,
      baselineLocal: 11_000,
      confidence: 0.6,
      basis: "collected-median",
      sampleSize: 34,
      propertyUniverse: 51,
      collectedAt: "2026-09-28T00:00:00Z",
      stale: true,
    },
  ];
  for (const quote of hotelQuotes) {
    dimensions.push(scoreHotel(quote));
  }

  const baseFlight = {
    basis: "cached-fare" as const,
    fareLocal: 700,
    fetchedAt: NOW.toISOString(),
    confidence: 0.7,
    distanceModel: { roundTripMiles: 2164, dollarsPerMile: 0.1, theoreticalUsd: 216.4 },
  };
  const flightInputs = [
    // Percentile paths: new low, cheap, typical, expensive, and top of range.
    ...[0, 20, 50, 80, 100].map((percentile) => ({
      kind: "quote" as const,
      quote: {
        ...baseFlight,
        fareLocal: 600 + percentile * 8,
        history: { lookbackDays: 90, min: 600, max: 1400, median: 900, percentile },
      },
    })),
    // Distance-model fallbacks, below and above the anchor.
    { kind: "quote" as const, quote: { ...baseFlight, fareLocal: 150 } },
    { kind: "quote" as const, quote: { ...baseFlight, fareLocal: 900 } },
    // Blended basis.
    {
      kind: "quote" as const,
      quote: {
        ...baseFlight,
        basis: "blended" as const,
        history: { lookbackDays: 90, min: 600, max: 1400, median: 900, percentile: 40 },
      },
    },
    // Stale cache.
    {
      kind: "quote" as const,
      quote: { ...baseFlight, fetchedAt: "2026-09-15T00:00:00Z" },
    },
    // Unavailable, both reasons.
    { kind: "unavailable" as const, reason: "outside-booking-window" as const, bookingOpensOn: "2027-01-15" },
    { kind: "unavailable" as const, reason: "no-quote" as const },
  ];
  for (const input of flightInputs) {
    dimensions.push(scoreFlight(input));
  }

  const holidaySets: Holiday[][] = [
    [],
    [{ date: "2026-09-25", country: "JP", name: { en: "H", zh: "节" }, weight: "normal" }],
    // A consecutive peak run.
    ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"].map((date) => ({
      date,
      country: "JP",
      name: { en: "Golden Week", zh: "黄金周" },
      weight: "peak" as const,
    })),
  ];
  for (const holidays of holidaySets) {
    dimensions.push(scoreCrowd(holidays, TRIP));
  }

  const fxSnapshots: Array<FxSnapshot | null> = [
    null,
    { from: "CNY", to: "JPY", rate: 23.51, yearLow: 17.5, yearHigh: 24.2, asOf: "2026-09-22T00:00:00Z" },
    { from: "CNY", to: "JPY", rate: 24.2, yearLow: 17.5, yearHigh: 24.2, asOf: "2026-09-22T00:00:00Z" },
    { from: "CNY", to: "JPY", rate: 17.5, yearLow: 17.5, yearHigh: 24.2, asOf: "2026-09-22T00:00:00Z" },
    { from: "CNY", to: "JPY", rate: 21, yearLow: 17.5, yearHigh: 24.2, asOf: "2026-09-22T00:00:00Z" },
    { from: "CNY", to: "HKD", rate: 1.1, yearLow: 1.095, yearHigh: 1.105, asOf: "2026-09-22T00:00:00Z" },
  ];
  for (const fx of fxSnapshots) {
    dimensions.push(scoreFx(fx));
  }

  return dimensions;
}

/** Every driver key the scorers can emit. */
function collectKeys(): string[] {
  return collectDimensions().flatMap((dimension) => dimension.drivers);
}

/**
 * Every fact *label* key the scorers can emit.
 *
 * `DimensionCard` renders each fact as `t("fact." + key)`, so a fact whose name is
 * absent from the dictionary shows up in the UI as a raw identifier like
 * `fact.perNightLocal`. Nothing in the type system connects the two, which is
 * exactly why this test exists: it caught seven such labels when it was added.
 */
function collectFactKeys(): string[] {
  const keys: string[] = [];
  for (const dimension of collectDimensions()) {
    for (const key of Object.keys(dimension.facts)) {
      // `disclaimer` is special-cased by the card: its *value* is an i18n key.
      keys.push(key === "disclaimer" ? String(dimension.facts[key]) : `fact.${key}`);
    }
    // Enumerated values carry their own keys.
    if (typeof dimension.facts.basis === "string") {
      keys.push(`${dimension.key}.basis.${dimension.facts.basis}`);
    }
  }
  return keys;
}

/**
 * Every i18n key the *components* name literally.
 *
 * The scorer walker above cannot see these, and that gap shipped a real bug: the
 * results section called `t("result.detailsHeading")` for a key that was never added to
 * either dictionary, so users were shown the raw string `result.detailsHeading` as a
 * heading. The translator deliberately falls back to the key rather than throwing —
 * which is right for a runtime, and exactly why a test has to look.
 */
function collectComponentKeys(): string[] {
  const dir = fileURLToPath(new URL("../../components/", import.meta.url));
  const keys: string[] = [];

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".tsx")) continue;
    const source = readFileSync(`${dir}${name}`, "utf8");

    /**
     * Comments are stripped first: the components *describe* their i18n contract in
     * prose (`The row label is t("fact." + key)`), and scanning that text would assert
     * against a key that is deliberately not one.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    // `t("a.b")`. A template literal (`t(`a.${x}`)`) is skipped: the interpolated part
    // is data, not a key.
    for (const match of code.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"/g)) {
      keys.push(match[1]);
    }
    // Keys reached through another i18n key's value, e.g. `t(value)` where value is an
    // i18n key — those are asserted by the scorer walker instead.
  }

  return [...new Set(keys)];
}

describe("i18n coverage", () => {
  it("has a translation for every key a component names literally", () => {
    const missing = collectComponentKeys().filter((key) => !existsInEveryLocale(key));
    expect(missing).toEqual([]);
  });

  it("checks a useful number of component keys, so the scan cannot silently find none", () => {
    expect(collectComponentKeys().length).toBeGreaterThan(25);
  });

  it("has a translation in every locale for every driver key the scorers emit", () => {
    const keys = [...new Set(collectKeys())];
    expect(keys.length).toBeGreaterThan(25);
    const missing = keys.filter((key) => !existsInEveryLocale(key));
    expect(missing).toEqual([]);
  });

  it("has a translation in every locale for every fact label the scorers emit", () => {
    const keys = [...new Set(collectFactKeys())];
    expect(keys.length).toBeGreaterThan(20);
    const missing = keys.filter((key) => !existsInEveryLocale(key));
    expect(missing).toEqual([]);
  });

  it("covers every warning key scoreTrip can produce", () => {
    // Exercise the warning branches: low confidence, mock hotel, unavailable
    // flight, capped total, and same-currency.
    const result = scoreTrip(
      { ...TRIP, destination: { ...HND } },
      {
        weather: {
          date: "2026-12-20",
          basis: "climate-normal",
          tempC: 22,
          humidityPct: 55,
          tempSpreadC: 6,
          humiditySpreadPct: 18,
        },
        hotel: {
          perNightLocal: 3000,
          baselineLocal: 500,
          confidence: 0.5,
          basis: "mock-flat",
          sampleSize: 3,
        },
        flight: { kind: "unavailable", reason: "outside-booking-window" },
        holidays: [],
        fx: null,
        computedAt: NOW.toISOString(),
      },
    );

    expect(result.warnings.length).toBeGreaterThan(2);
    const missing = result.warnings.filter((key) => !existsInEveryLocale(key));
    expect(missing).toEqual([]);
  });

  it("covers every dimension label", () => {
    // The confidence labels are gone with the confidence badges they rendered.
    const keys = [
      "dimension.weather",
      "dimension.hotel",
      "dimension.flight",
      "dimension.crowd",
      "dimension.fx",
    ];
    expect(keys.filter((key) => !existsInEveryLocale(key))).toEqual([]);
  });

  it("has complete key parity between locales", () => {
    const en = Object.keys(MESSAGES.en).sort();
    const zh = Object.keys(MESSAGES.zh).sort();
    expect(zh).toEqual(en);
  });

  it("falls back to the default locale rather than rendering a raw key", () => {
    // Present in en, so zh must resolve via fallback rather than showing the key.
    expect(translate("zh", "app.title")).not.toBe("app.title");
    // Genuinely unknown keys surface loudly, which is what we want in dev.
    expect(translate("zh", "totally.unknown.key")).toBe("totally.unknown.key");
  });

  it("interpolates placeholders in both locales", () => {
    expect(translate("en", "result.days", { days: 5 })).toContain("5");
    expect(translate("zh", "result.days", { days: 5 })).toContain("5");
    expect(translate("en", "result.days", { days: 5 })).not.toContain("{days}");
    expect(translate("zh", "result.days", { days: 5 })).not.toContain("{days}");
  });
});
