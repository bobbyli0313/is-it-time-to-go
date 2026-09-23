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

/** Every key any scorer can emit, gathered by exercising every branch. */
function collectKeys(): string[] {
  const keys: string[] = [];

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
    keys.push(...scoreWeather(sample, TRIP, NOW).drivers);
  }

  const hotelQuotes: HotelQuote[] = [
    { perNightLocal: 300, baselineLocal: 500, confidence: 0.8, basis: "hotel-price-index", sampleSize: 20 },
    { perNightLocal: 700, baselineLocal: 500, confidence: 0.8, basis: "hotel-price-index", sampleSize: 20 },
    { perNightLocal: 1000, baselineLocal: 500, confidence: 0.8, basis: "hotel-price-index", sampleSize: 20 },
    { perNightLocal: 2600, baselineLocal: 500, confidence: 0.8, basis: "hotel-price-index", sampleSize: 3 },
    { perNightLocal: 800, baselineLocal: 500, confidence: 0.4, basis: "mock-flat", sampleSize: 3 },
  ];
  for (const quote of hotelQuotes) {
    keys.push(...scoreHotel(quote).drivers);
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
    keys.push(...scoreFlight(input).drivers);
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
    keys.push(...scoreCrowd(holidays, TRIP).drivers);
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
    keys.push(...scoreFx(fx).drivers);
  }

  return keys;
}

describe("i18n coverage", () => {
  it("has a translation in every locale for every driver key the scorers emit", () => {
    const keys = [...new Set(collectKeys())];
    expect(keys.length).toBeGreaterThan(25);
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

  it("covers every dimension and confidence label", () => {
    const keys = [
      "dimension.weather",
      "dimension.hotel",
      "dimension.flight",
      "dimension.crowd",
      "dimension.fx",
      "confidence.high",
      "confidence.medium",
      "confidence.low",
      "confidence.notApplicable",
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
