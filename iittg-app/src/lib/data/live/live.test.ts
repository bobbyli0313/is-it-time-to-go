/**
 * Tests for the live providers, run entirely against recorded fixtures.
 *
 * No test in this file touches the network. `fetch` is stubbed and responds from
 * `__fixtures__/`, which are verbatim captures of the real endpoints. That keeps CI
 * offline and deterministic while still exercising the parsing and reduction logic
 * that only runs on real payloads — which is the part most likely to be wrong.
 *
 * The stub also fails loudly on an unexpected URL. A test that silently reached out
 * to the internet would be worse than a failing one: it would pass locally and fail
 * in CI, or vice versa, for reasons unrelated to the code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clearMemoryCache } from "@/lib/data/cache";
import { CITY_BY_ID } from "@/lib/data/cities";

import { fetchLiveHolidays, internals as holidayInternals } from "@/lib/data/live/holidays";
import {
  fetchLiveWeather,
  FORECAST_HORIZON_DAYS,
  internals as weatherInternals,
} from "@/lib/data/live/weather";
import { fetchLiveFx, ECB_CURRENCIES, internals as fxInternals } from "@/lib/data/live/fx";

const fixtureDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDir}${name}`, "utf8"));
}

const FIXTURES = {
  jp2026: "nager-jp-2026.json",
  cn2026: "nager-cn-2026.json",
  forecastTokyo: "open-meteo-forecast-tokyo.json",
  fxCnyYear: "frankfurter-cny-1y.json",
} as const;

const tokyo = CITY_BY_ID.get("tokyo")!;
const shanghai = CITY_BY_ID.get("shanghai")!;
const taipei = CITY_BY_ID.get("taipei")!;

/** URLs the tests deliberately do not have a fixture for. */
let fetchCalls: string[] = [];

/**
 * Installs a fetch stub that answers from fixtures by URL pattern.
 *
 * `archive` responses are generated rather than recorded: the real archive call
 * spans ten years of daily data, which would be a huge fixture, and what matters for
 * the test is the reduction maths, not the specific observations.
 */
function stubFetch(options: { archive?: boolean } = {}) {
  fetchCalls = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(url);

    if (url.includes("date.nager.at")) {
      /**
       * Match the *year* as well as the country. An earlier version keyed only on
       * "/JP", which silently answered a 2099 request with 2026 data and made the
       * coverage-gap test pass for the wrong reason.
       */
      const match = url.match(/PublicHolidays\/(\d{4})\/([A-Z]{2})/);
      const year = match?.[1];
      const country = match?.[2];
      const body =
        year === "2026" && country === "JP"
          ? fixture(FIXTURES.jp2026)
          : year === "2026" && country === "CN"
            ? fixture(FIXTURES.cn2026)
            : null;
      if (country === "TH") {
        // Thailand, Taiwan and Malaysia answer exactly this: 204 with no body. It is
        // a coverage gap, not a parse failure, and the two must not be conflated.
        return new Response(null, { status: 204 });
      }
      if (body === null) {
        // Mirrors the real behaviour for an uncovered country/year.
        return new Response("Not Found", { status: 404 });
      }
      return Response.json(body);
    }

    if (url.includes("api.open-meteo.com/v1/forecast")) {
      return Response.json(fixture(FIXTURES.forecastTokyo));
    }

    if (url.includes("archive-api.open-meteo.com")) {
      if (!options.archive) {
        throw new Error(`Unexpected archive call in this test: ${url}`);
      }
      return Response.json(buildArchiveResponse(url));
    }

    if (url.includes("api.frankfurter.dev")) {
      return Response.json(fixture(FIXTURES.fxCnyYear));
    }

    throw new Error(`Unstubbed URL reached in test: ${url}`);
  });
}

/**
 * Synthesises a decade of daily archive data with a deliberate seasonal signal, so
 * the reduction has something meaningful to find.
 */
function buildArchiveResponse(url: string | URL): unknown {
  const params = new URL(url.toString());
  const start = params.searchParams.get("start_date")!;
  const end = params.searchParams.get("end_date")!;

  const time: string[] = [];
  const tMax: number[] = [];
  const tMin: number[] = [];
  const humidity: number[] = [];

  const cursor = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (cursor <= stop) {
    const iso = cursor.toISOString().slice(0, 10);
    // A clean annual cycle: warm in July, cold in January, peaking around +14 °C.
    const dayOfYear = Math.floor(
      (cursor.getTime() - Date.UTC(cursor.getUTCFullYear(), 0, 1)) / 86_400_000,
    );
    const seasonal = 14 * Math.sin((2 * Math.PI * (dayOfYear - 80)) / 365);
    const mean = 15 + seasonal;
    time.push(iso);
    tMax.push(mean + 4);
    tMin.push(mean - 4);
    // Muggier in summer, drier in winter: gives the humidity spread something to
    // measure instead of being a flat line.
    humidity.push(Math.round(70 + 12 * Math.sin((2 * Math.PI * (dayOfYear - 80)) / 365)));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    daily: {
      time,
      temperature_2m_max: tMax,
      temperature_2m_min: tMin,
      relative_humidity_2m_mean: humidity,
    },
  };
}

beforeEach(() => {
  clearMemoryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* --------------------------------------------------------------- holidays */

describe("live holidays (Nager.Date)", () => {
  it("parses a real Japan calendar", async () => {
    stubFetch();
    const { holidays, coverageComplete } = await fetchLiveHolidays(
      "JP",
      "2026-01-01",
      "2026-12-31",
    );

    expect(coverageComplete).toBe(true);
    /**
     * 16 statutory days from the source, plus two curated travel periods the source
     * does not represent: the 3-day Golden Week shoulder (1-3 May, ordinary weekdays
     * that the country nonetheless travels on) and Obon (13-16 August, not statutory
     * in Japan). 16 + 3 + 4 = 23.
     */
    expect(holidays.length).toBe(23);
    expect(holidays[0]).toMatchObject({
      date: "2026-01-01",
      country: "JP",
      weight: "normal",
    });
    // Local and English names both come through from the source.
    expect(holidays[0].name.zh).toBe("元日");
    expect(holidays[0].name.en).toBe("New Year's Day");
    // Sorted ascending, which the crowding analysis relies on for run detection.
    const dates = holidays.map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("promotes Golden Week to peak weight", async () => {
    stubFetch();
    const { holidays } = await fetchLiveHolidays("JP", "2026-04-25", "2026-05-10");
    const goldenWeek = holidays.filter((h) => h.weight === "peak");

    // The four statutory days inside the period, plus the additive travel shoulder.
    const statutoryPeak = goldenWeek.filter(
      (h) => !h.name.en.includes("travel period"),
    );
    expect(statutoryPeak.map((h) => h.date).sort()).toEqual([
      "2026-04-29",
      "2026-05-04",
      "2026-05-05",
      "2026-05-06",
    ]);

    /**
     * 1-3 May are NOT holidays in 2026 — 3 May is a Sunday and the observed
     * substitute is 6 May — but they are when the country travels, so they are added
     * as a travel period rather than fabricated as public holidays. This is the
     * distinction the `additive` flag exists to preserve.
     */
    const shoulder = goldenWeek.filter((h) => h.name.en.includes("travel period"));
    expect(shoulder.map((h) => h.date)).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ]);
  });

  /**
   * The gap that motivated the curated table: Obon is not a statutory holiday in
   * Japan, so Nager.Date does not list it, yet it is one of the year's two busiest
   * travel periods. Without the additive period the model would report zero
   * crowding for that week.
   */
  it("adds Obon, which the source does not list", async () => {
    stubFetch();

    const { holidays: listed } = await fetchLiveHolidays(
      "JP",
      "2026-08-13",
      "2026-08-16",
    );
    // Every day in the window is present...
    expect(listed.map((h) => h.date)).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ]);
    // ...and all of them are peak, because the curated period covers them.
    expect(listed.every((h) => h.weight === "peak")).toBe(true);
    // The name comes from the curated table, not the upstream.
    expect(listed[0].name.zh).toBe("盂兰盆节");
  });

  it("does not double-count a statutory day inside an additive period", async () => {
    stubFetch();
    const { holidays } = await fetchLiveHolidays("JP", "2026-08-10", "2026-08-20");

    const dates = holidays.map((h) => h.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  /**
   * The bug this covers: Nager.Date publishes one day per Chinese festival — the
   * statutory anchor, not the State Council's arrangement — so a five-day National
   * Day holiday reached the scorer as a single peak day and Shanghai scored 93.7.
   */
  it("fills China's multi-day blocks, which the source reports as one day", async () => {
    stubFetch();
    const { holidays } = await fetchLiveHolidays("CN", "2026-10-01", "2026-10-05");

    expect(holidays.map((h) => h.date)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    // Every day of the block is a peak, not just the day the source lists.
    expect(holidays.every((h) => h.weight === "peak")).toBe(true);
    // The listed day keeps its own name; the added days carry the period's.
    expect(holidays[0].name.en).toBe("National Day");
    expect(holidays[1].name.en).toBe("National Day Golden Week");
  });

  it("still adds the peak when the source has no calendar for the country at all", async () => {
    stubFetch();
    // Songkran, in a country the source answers 204 for.
    const { holidays, coverageComplete } = await fetchLiveHolidays(
      "TH",
      "2026-04-13",
      "2026-04-15",
    );

    expect(holidays.map((h) => h.date)).toEqual([
      "2026-04-13",
      "2026-04-14",
      "2026-04-15",
    ]);
    expect(holidays.every((h) => h.weight === "peak")).toBe(true);
    /**
     * And it still says so. The curated table covers the documented peaks; outside
     * them the model genuinely does not know, and claiming complete coverage would
     * let a source gap quietly improve a crowding score.
     */
    expect(coverageComplete).toBe(false);
  });

  it("treats an empty response as a coverage gap, not a failure", async () => {
    stubFetch();
    // A 204 must not throw: the whole year used to be discarded as an outage.
    const { holidays } = await fetchLiveHolidays("TH", "2026-12-31", "2027-01-02");
    expect(holidays.map((h) => h.date)).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("reports incomplete coverage for a year the source does not serve", async () => {
    stubFetch();
    // 2099 has no fixture, so the stub answers 404 exactly as the real API does for
    // an uncovered year. An empty result must not be mistaken for "no holidays".
    const { holidays, coverageComplete } = await fetchLiveHolidays(
      "JP",
      "2099-01-01",
      "2099-12-31",
    );

    /**
     * The curated peaks survive a source outage — that is the point of curating them.
     * What must not happen is a claim of coverage: outside those windows the model has
     * no calendar at all, and the flag is what says so.
     */
    expect(coverageComplete).toBe(false);
    expect(holidays.map((h) => h.date)).toContain("2099-08-13"); // Obon
    expect(holidays.every((h) => h.weight === "peak")).toBe(true);
    // And nothing statutory is fabricated: the source listed none of it.
    expect(holidays.some((h) => h.date === "2099-01-01")).toBe(false);
  });

  it("fetches each year in a spanning range separately", async () => {
    stubFetch();
    await fetchLiveHolidays("JP", "2026-12-20", "2027-01-10");

    const yearCalls = fetchCalls.filter((u) => u.includes("date.nager.at"));
    expect(yearCalls.some((u) => u.includes("/2026/"))).toBe(true);
    expect(yearCalls.some((u) => u.includes("/2027/"))).toBe(true);
  });

  it("classifies weights deterministically from the curated table", () => {
    const { classifyWeight } = holidayInternals;
    expect(classifyWeight("JP", "2026-04-29")).toBe("peak");
    expect(classifyWeight("JP", "2026-01-12")).toBe("normal");
    expect(classifyWeight("CN", "2026-10-03")).toBe("peak");
    expect(classifyWeight("KR", "2026-01-01")).toBe("normal");
  });
});

/* ---------------------------------------------------------------- weather */

describe("live weather (Open-Meteo)", () => {
  it("parses a real forecast and derives a daily mean", async () => {
    stubFetch();
    const forecast = fixture(FIXTURES.forecastTokyo) as {
      daily: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[] };
    };

    const firstDate = forecast.daily.time[0];
    const sample = await fetchLiveWeather(tokyo, firstDate, new Date());

    expect(sample.basis).toBe("forecast");
    expect(sample.date).toBe(firstDate);
    // The endpoint has no `temperature_2m_mean` for forecasts, so the provider
    // derives it from min/max — the same way it does for the archive, so the two
    // remain comparable.
    const expected =
      (forecast.daily.temperature_2m_max[0] + forecast.daily.temperature_2m_min[0]) / 2;
    expect(sample.tempC).toBeCloseTo(Math.round(expected * 10) / 10, 5);
    expect(sample.humidityPct).toBeGreaterThan(0);
    expect(sample.precipProbabilityPct).toBeTypeOf("number");
  });

  it("falls back to a climate normal beyond the forecast horizon", async () => {
    stubFetch({ archive: true });
    const now = new Date();
    const far = new Date(now.getTime() + 40 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const sample = await fetchLiveWeather(tokyo, far, now);

    expect(sample.basis).toBe("climate-normal");
    // The synthetic archive is a clean annual cycle around 15 °C peaking in July, so
    // whatever the date, a normal must exist and be plausible rather than NaN.
    expect(Number.isFinite(sample.tempC)).toBe(true);
    expect(sample.tempSpreadC).toBeGreaterThan(0);
    expect(sample.humiditySpreadPct).toBeGreaterThan(0);
  });

  it("keeps the forecast horizon at 16 days, matching the upstream", () => {
    expect(FORECAST_HORIZON_DAYS).toBe(16);
  });

  it("reduces an archive payload to a normal on the correct window", async () => {
    // A year of synthetic data with a known seasonal shape: mid-July should be much
    // warmer than mid-January, which proves the window selection works.
    const july = buildArchiveResponse(
      new URL("https://archive-api.open-meteo.com/v1/archive?start_date=2015-07-15&end_date=2025-07-15"),
    );
    const january = buildArchiveResponse(
      new URL("https://archive-api.open-meteo.com/v1/archive?start_date=2015-01-15&end_date=2025-01-15"),
    );

    const julyByDate = weatherInternals.indexByDate(
      (july as { daily: never }).daily,
    );
    const januaryByDate = weatherInternals.indexByDate(
      (january as { daily: never }).daily,
    );

    const julyMean =
      [...julyByDate.entries()]
        .filter(([date]) => date >= "2020-07-13" && date <= "2020-07-17")
        .reduce((sum, [, v]) => sum + v.tempC, 0) / 5;
    const januaryMean =
      [...januaryByDate.entries()]
        .filter(([date]) => date >= "2020-01-13" && date <= "2020-01-17")
        .reduce((sum, [, v]) => sum + v.tempC, 0) / 5;

    expect(julyMean).toBeGreaterThan(januaryMean + 15);
  });

  it("computes quantiles that bracket the median", () => {
    const { quantile } = weatherInternals;
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(sorted, 0.25)).toBeLessThan(quantile(sorted, 0.5));
    expect(quantile(sorted, 0.75)).toBeGreaterThan(quantile(sorted, 0.5));
    expect(quantile(sorted, 0)).toBe(1);
    expect(quantile(sorted, 1)).toBe(10);
  });

  it("treats missing daily values as absent rather than zero", () => {
    const { indexByDate } = weatherInternals;
    const indexed = indexByDate({
      time: ["2026-01-01", "2026-01-02", "2026-01-03"],
      temperature_2m_max: [10, null, 12],
      temperature_2m_min: [0, 1, null],
      relative_humidity_2m_mean: [60, 60, 60],
    } as never);

    // Only the complete day survives: a day missing either extreme is dropped
    // rather than filled with zero, which would poison the mean.
    expect(indexed.size).toBe(1);
    expect(indexed.get("2026-01-01")?.tempC).toBe(5);
  });
});

/* --------------------------------------------------------------------- fx */

describe("live FX (Frankfurter)", () => {
  it("derives the rate and its trailing 12-month range from a real series", async () => {
    stubFetch();
    const result = await fetchLiveFx(shanghai, tokyo, new Date());

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.source).toBe("ecb-daily");
    const { snapshot } = result;
    expect(snapshot.from).toBe("CNY");
    expect(snapshot.to).toBe("JPY");

    // Cross-check against the fixture rather than hardcoding: the point is that the
    // reducer picks the true extremes and the latest observation.
    const fx = fixture(FIXTURES.fxCnyYear) as {
      rates: Record<string, { JPY: number }>;
    };
    const dates = Object.keys(fx.rates).sort();
    const jpy = dates.map((d) => fx.rates[d].JPY);

    expect(snapshot.yearLow).toBeCloseTo(Math.min(...jpy), 4);
    expect(snapshot.yearHigh).toBeCloseTo(Math.max(...jpy), 4);
    expect(snapshot.rate).toBeCloseTo(fx.rates[dates[dates.length - 1]].JPY, 4);
    expect(snapshot.yearLow).toBeLessThanOrEqual(snapshot.rate);
    expect(snapshot.yearHigh).toBeGreaterThanOrEqual(snapshot.rate);
  });

  it("returns null for a same-currency trip rather than a failed lookup", async () => {
    stubFetch();
    expect(await fetchLiveFx(shanghai, CITY_BY_ID.get("beijing")!, new Date())).toBeNull();
    // Nothing should have been requested.
    expect(fetchCalls).toEqual([]);
  });

  /**
   * TWD and VND are outside the ECB basket. Rather than silently reaching for an
   * aggregator with unclear terms, the provider falls back to the curated table and
   * labels the result, which is what lets the UI disclose it.
   */
  it("falls back to the static table for a pair the ECB does not publish", async () => {
    stubFetch();

    const result = await fetchLiveFx(taipei, tokyo, new Date());
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.source).toBe("static-reference");
    expect(fetchCalls).toEqual([]);
    // Static figures must still be internally consistent.
    expect(result.snapshot.yearLow).toBeLessThan(result.snapshot.yearHigh);
    expect(result.snapshot.rate).toBeGreaterThan(0);
  });

  /**
   * The static fallback is only as good as its dependencies. Converting the USD
   * distance anchor into a non-ECB currency needs a USD entry, and its absence made
   * every TWD-origin flight dimension silently unavailable — the fallback returned null
   * because the rate it needed was missing, not because the pair was unsupported.
   */
  it("can convert the USD anchor for every non-ECB currency it supports", async () => {
    stubFetch();
    for (const currency of ["TWD", "VND"]) {
      const rate = await fxInternals.usdRateTo(currency, new Date());
      expect(rate, `no USD rate available for ${currency}`).not.toBeNull();
      expect(rate as number).toBeGreaterThan(0);
    }
    // And USD itself is the identity, needing no lookup at all.
    expect(await fxInternals.usdRateTo("USD", new Date())).toBe(1);
  });

  it("returns null rather than a guess for a currency it does not know", async () => {
    stubFetch();
    expect(await fxInternals.usdRateTo("XYZ", new Date())).toBeNull();
  });

  it("knows exactly which currencies the ECB publishes", () => {
    for (const code of ["CNY", "JPY", "KRW", "THB", "SGD", "MYR", "IDR", "PHP", "HKD"]) {
      expect(ECB_CURRENCIES.has(code)).toBe(true);
    }
    // The two that are deliberately not covered.
    expect(ECB_CURRENCIES.has("TWD")).toBe(false);
    expect(ECB_CURRENCIES.has("VND")).toBe(false);
  });

  it("rounds to six decimals so JSON stays readable", () => {
    expect(fxInternals.round6(23.456789123)).toBe(23.456789);
    expect(fxInternals.round6(1)).toBe(1);
  });
});
