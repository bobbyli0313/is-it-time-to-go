import { describe, expect, it } from "vitest";
import {
  PARAMS,
  analyseCrowding,
  clamp,
  computeTotal,
  scoreCrowd,
  scoreFlight,
  scoreFx,
  scoreHotel,
  scoreTrip,
  scoreWeather,
} from "./index";
import {
  addDays,
  diffDays,
  enumerateDates,
  formatIsoDate,
  isWeekend,
  isValidIsoDate,
  parseIsoDate,
  todayForTrip,
  todayIn,
  tripLengthDays,
} from "./dates";
import type {
  City,
  DimensionScore,
  FlightQuote,
  FxSnapshot,
  Holiday,
  HotelQuote,
  TripInput,
  WeatherSample,
} from "./types";

/* ------------------------------------------------------------------ fixtures */

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

function dim(
  key: DimensionScore["key"],
  score: number | null,
  applicable = score !== null,
): DimensionScore {
  return {
    key,
    score,
    applicable,
    confidence: "high",
    weight: 0.2,
    facts: {},
    drivers: [],
  };
}

/* ------------------------------------------------------------------- dates */

describe("dates", () => {
  it("parses and round-trips ISO dates", () => {
    expect(formatIsoDate(parseIsoDate("2026-09-25"))).toBe("2026-09-25");
    expect(addDays("2026-09-25", 5)).toBe("2026-09-30");
    expect(diffDays("2026-09-25", "2026-09-30")).toBe(5);
  });

  it("crosses a month and a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(diffDays("2026-12-30", "2027-01-02")).toBe(3);
  });

  it("rejects malformed and rolled-over dates", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2025-02-29")).toBe(false);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(() => parseIsoDate("25/09/2026")).toThrow();
  });

  it("counts a same-day return as one day", () => {
    expect(tripLengthDays("2026-09-25", "2026-09-25")).toBe(1);
    expect(tripLengthDays("2026-09-25", "2026-09-30")).toBe(6);
  });

  it("enumerates an inclusive range", () => {
    expect(enumerateDates("2026-09-25", "2026-09-27")).toEqual([
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ]);
    expect(enumerateDates("2026-09-25", "2026-09-24")).toEqual([]);
  });

  it("identifies weekends", () => {
    expect(isWeekend("2026-09-26")).toBe(true); // Saturday
    expect(isWeekend("2026-09-27")).toBe(true); // Sunday
    expect(isWeekend("2026-09-25")).toBe(false); // Friday
  });

  /**
   * The timezone bug this guards against: at 04:00 UTC on 22 Sep it is already
   * the 22nd in Tokyo (+9) but still the 21st in Los Angeles (-7). A naive
   * `new Date().toISOString()` would score the wrong calendar day.
   */
  it("resolves 'today' per timezone", () => {
    const now = new Date("2026-09-22T04:00:00Z");
    expect(todayIn("Asia/Tokyo", now)).toBe("2026-09-22");
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-09-21");
    expect(todayIn("UTC", now)).toBe("2026-09-22");
  });

  it("takes the later of the two cities' today for a trip", () => {
    const now = new Date("2026-09-22T04:00:00Z");
    expect(todayForTrip("America/Los_Angeles", "Asia/Tokyo", now)).toBe(
      "2026-09-22",
    );
    expect(todayForTrip("Asia/Tokyo", "America/Los_Angeles", now)).toBe(
      "2026-09-22",
    );
  });
});

/* ----------------------------------------------------------------- weather */

describe("scoreWeather", () => {
  const forecast = (tempC: number, humidityPct: number): WeatherSample => ({
    date: "2026-09-25",
    basis: "forecast",
    tempC,
    humidityPct,
    tempSpreadC: 2,
    humiditySpreadPct: 8,
  });

  it("gives 100 at exactly 25C and 50% humidity", () => {
    const s = scoreWeather(forecast(25, 50), TRIP, NOW);
    expect(s.score).toBe(100);
  });

  it("matches the worked example for a 3-day-out forecast", () => {
    // PLANS: "Tokyo 25 Sep, sunny, 25C, 50% humidity -> weather score 100"
    const s = scoreWeather(forecast(25, 50), TRIP, NOW);
    expect(s.score).toBe(100);
    expect(s.confidence).toBe("high");
    expect(s.facts.basis).toBe("forecast");
    expect(s.debug?.daysOut).toBe(3);
  });

  it("decays symmetrically as temperature departs from ideal", () => {
    const cold = scoreWeather(forecast(15, 50), TRIP, NOW).score as number;
    const hot = scoreWeather(forecast(35, 50), TRIP, NOW).score as number;
    expect(cold).toBeCloseTo(hot, 5);
    // 10C off ideal with perfect humidity lands in the mid-70s, not the 60s:
    // humidity is 40% of the weather score and here it is ideal.
    expect(cold).toBeLessThan(80);
    expect(cold).toBeGreaterThan(65);
  });

  it("scores a hot humid day below a hot dry day", () => {
    const humid = scoreWeather(forecast(33, 85), TRIP, NOW).score as number;
    const dry = scoreWeather(forecast(33, 50), TRIP, NOW).score as number;
    expect(humid).toBeLessThan(dry);
  });

  /**
   * The honesty requirement: a climate normal is an average of many years, so it
   * can never be as trustworthy as a forecast no matter how perfect its mean is.
   */
  it("never rates a climate normal as high confidence", () => {
    const normal: WeatherSample = {
      date: "2026-10-20",
      basis: "climate-normal",
      tempC: 25,
      humidityPct: 50,
      tempSpreadC: 6,
      humiditySpreadPct: 18,
    };
    const s = scoreWeather(normal, TRIP, NOW);
    expect(s.score).toBe(100);
    expect(s.confidence).toBe("medium");
    expect(s.drivers).toContain("weather.driver.climateNormal");
  });

  it("drops a climate normal to low confidence far in the future", () => {
    const far: WeatherSample = {
      date: "2026-11-20",
      basis: "climate-normal",
      tempC: 25,
      humidityPct: 50,
      tempSpreadC: 6,
      humiditySpreadPct: 18,
    };
    expect(scoreWeather(far, TRIP, NOW).confidence).toBe("low");
  });

  it("degrades a distant forecast to medium confidence", () => {
    const distant: WeatherSample = {
      ...forecast(25, 50),
      date: "2026-10-02", // 10 days out
    };
    expect(scoreWeather(distant, TRIP, NOW).confidence).toBe("medium");
  });

  it("always discloses which single day was sampled", () => {
    const s = scoreWeather(forecast(25, 50), TRIP, NOW);
    expect(s.debug?.sampledDate).toBe("2026-09-25");
  });
});

/* ------------------------------------------------------------------- hotel */

describe("scoreHotel", () => {
  const quote = (perNightLocal: number, baselineLocal = 500): HotelQuote => ({
    perNightLocal,
    baselineLocal,
    confidence: 0.8,
    basis: "chain-direct-median",
    sampleSize: 20,
  });

  it("gives full marks at or below the baseline", () => {
    expect(scoreHotel(quote(500)).score).toBe(100);
    expect(scoreHotel(quote(300)).score).toBe(100);
  });

  /**
   * PLANS's worked example: "Tokyo, 1000/night -> hotel score 70".
   * The original spec never stated a formula, so the decay constant was fitted
   * to reproduce this data point.
   */
  it("reproduces the worked example: 2x baseline -> ~70", () => {
    const s = scoreHotel(quote(1000));
    expect(s.score).toBeGreaterThanOrEqual(69);
    expect(s.score).toBeLessThanOrEqual(71);
  });

  it("degrades monotonically but never reaches zero", () => {
    const scores = [500, 750, 1000, 1500, 2000, 4000].map(
      (p) => scoreHotel(quote(p)).score as number,
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
    expect(scores[scores.length - 1]).toBeGreaterThan(0);
  });

  it("flags a thin sample and lowers confidence", () => {
    const s = scoreHotel({ ...quote(900), sampleSize: 4 });
    expect(s.confidence).not.toBe("high");
    expect(s.drivers).toContain("hotel.driver.thinSample");
  });

  it("labels the basis so the UI can say this is collected data, not a quote", () => {
    const s = scoreHotel({ ...quote(1000), propertyUniverse: 51, collectedAt: "2026-09-28T00:00:00Z" });
    expect(s.facts.basis).toBe("chain-direct-median");
    expect(s.facts.disclaimer).toBe("fact.medianNotBookable");
    // Coverage is disclosed, not implied: 9 priced out of 51 known.
    expect(s.facts.sampleSize).toBe(20);
    expect(s.facts.propertyUniverse).toBe(51);
    expect(s.facts.collectedAt).toBe("2026-09-28T00:00:00Z");
  });

  it("withholds the amounts in index-only mode, and reports the distance instead", () => {
    const priced = scoreHotel({ ...quote(1000), disclosure: "price" });
    expect(priced.facts.perNight).toBe(1000);
    expect(priced.facts.baseline).toBe(500);
    expect(priced.facts.disclosure).toBe("price");

    const indexOnly = scoreHotel({ ...quote(1000), disclosure: "index" });
    // The score is identical — the ratio is all it needed.
    expect(indexOnly.score).toBe(priced.score);
    // But the numbers the source forbids publishing are gone from the response,
    // not merely hidden by a component: facts is what the browser receives.
    expect(indexOnly.facts.perNight).toBeUndefined();
    expect(indexOnly.facts.baseline).toBeUndefined();
    expect(indexOnly.facts.disclosure).toBe("index");
    // +100% over the ¥500 anchor.
    expect(indexOnly.facts.indexPctVsBaseline).toBe(100);
    // And the ratio goes with them: ratio × ¥500 would recover the amount.
    expect(indexOnly.facts.index).toBeUndefined();
    expect(indexOnly.drivers).toContain("hotel.driver.indexOnly");
  });

  it("drops confidence and says so when the collected prices are stale", () => {
    const fresh = scoreHotel(quote(900));
    const old = scoreHotel({ ...quote(900), stale: true });
    expect(old.drivers).toContain("hotel.driver.staleSamples");
    expect(old.confidence).toBe("low");
    expect(fresh.confidence).not.toBe("low");
  });
});

/* ------------------------------------------------------------------ flight */

describe("scoreFlight", () => {
  const baseQuote: FlightQuote = {
    basis: "cached-fare",
    fareLocal: 635,
    fetchedAt: NOW.toISOString(),
    confidence: 0.7,
    distanceModel: {
      roundTripMiles: 2164,
      dollarsPerMile: 0.1,
      theoreticalUsd: 216.4,
      /**
       * The anchor in the fare's own currency. Required, and required to be in the
       * *same* unit as `fareLocal`: dividing a CNY fare by a USD anchor is the bug this
       * field exists to prevent. Kept at the USD figure here so the ratio stays 2.93.
       */
      theoreticalLocal: 216.4,
    },
  };

  it("scores a fare at the bottom of history as a maximum", () => {
    const s = scoreFlight({
      kind: "quote",
      quote: {
        ...baseQuote,
        fareLocal: 600,
        history: {
          lookbackDays: 90,
          min: 600,
          max: 1400,
          median: 900,
          percentile: 0,
        },
      },
    });
    expect(s.score).toBe(100);
    // At the historical floor. The comparison carries a small tolerance for the
    // rounding applied when percentiles are bucketed from real sampled fares.
    expect(s.drivers).toContain("flight.driver.newLow");
  });

  it("scores a fare at the top of history as zero", () => {
    const s = scoreFlight({
      kind: "quote",
      quote: {
        ...baseQuote,
        history: {
          lookbackDays: 90,
          min: 600,
          max: 1400,
          median: 900,
          percentile: 100,
        },
      },
    });
    expect(s.score).toBe(0);
  });

  it("is percentile-driven, so an inherently pricey route is not punished twice", () => {
    const cheapRoute = scoreFlight({
      kind: "quote",
      quote: {
        ...baseQuote,
        fareLocal: 200,
        distanceModel: {
          roundTripMiles: 600,
          dollarsPerMile: 0.1,
          theoreticalUsd: 60,
          theoreticalLocal: 60,
          localPerUsd: 7.1,
        },
        history: { lookbackDays: 90, min: 150, max: 400, median: 250, percentile: 50 },
      },
    });
    const priceyRoute = scoreFlight({
      kind: "quote",
      quote: {
        ...baseQuote,
        fareLocal: 1200,
        distanceModel: {
          roundTripMiles: 6000,
          dollarsPerMile: 0.1,
          theoreticalUsd: 600,
          theoreticalLocal: 600,
          localPerUsd: 7.1,
        },
        history: { lookbackDays: 90, min: 900, max: 2400, median: 1500, percentile: 50 },
      },
    });
    expect(cheapRoute.score).toBe(priceyRoute.score);
  });

  it("keeps the distance model as a disclosed cross-check on every quote", () => {
    const s = scoreFlight({ kind: "quote", quote: baseQuote });
    expect(s.facts.theoreticalUsd).toBe(216.4);
    expect(s.facts.theoreticalLocal).toBe(216.4);
    expect(s.facts.fareToTheoreticalRatio).toBeCloseTo(2.93, 2);
  });

  /**
   * The unit contract. The distance anchor is defined in USD, so a fare in another
   * currency must be divided by the *converted* anchor. Without it, a CNY fare of 3,009
   * over a USD anchor of 218 scored as 13.8x when the real ratio was about 2x — a wrong
   * number presented with full confidence.
   */
  it("uses the converted anchor for the ratio, not the USD one", () => {
    const s = scoreFlight({
      kind: "quote",
      quote: {
        ...baseQuote,
        fareLocal: 3009,
        distanceModel: {
          roundTripMiles: 2164,
          dollarsPerMile: 0.1,
          theoreticalUsd: 216.4,
          theoreticalLocal: 1536.4, // 216.4 USD at 7.1 CNY/USD
          localPerUsd: 7.1,
        },
      },
    });
    // 3009 / 1536.4 = 1.96, not 3009 / 216.4 = 13.9.
    expect(s.facts.fareToTheoreticalRatio).toBeCloseTo(1.96, 2);
  });

  /**
   * When no rate is available the comparison cannot be made at all, so the dimension is
   * excluded rather than scored against the wrong unit.
   */
  it("excludes the dimension when no anchor conversion was possible", () => {
    const s = scoreFlight({
      kind: "quote",
      quote: {
        ...baseQuote,
        distanceModel: {
          roundTripMiles: 2164,
          dollarsPerMile: 0.1,
          theoreticalUsd: 216.4,
          // No theoreticalLocal: the adapter could not obtain a rate.
        },
      },
    });
    expect(s.score).toBeNull();
    expect(s.applicable).toBe(false);
    expect(s.drivers).toContain("flight.driver.noFxForAnchor");
    expect(s.facts.fareToTheoreticalRatio).toBeUndefined();
  });

  /**
   * The spec's worked example implies 20/100 for this fare, which the stated
   * "miles x $0.10" rule does not produce (it gives ~34). We reproduce the rule,
   * not the typo, and surface the raw ratio so the discrepancy is visible.
   */
  it("applies the distance-model fallback per the stated rule", () => {
    const s = scoreFlight({ kind: "quote", quote: baseQuote });
    expect(s.drivers).toContain("flight.driver.distanceModel");
    expect(s.score).toBeGreaterThan(15);
    expect(s.score).toBeLessThan(25);
  });

  it("marks a fare outside the booking window as not applicable, never zero", () => {
    const s = scoreFlight({
      kind: "unavailable",
      reason: "outside-booking-window",
      bookingOpensOn: "2027-01-15",
    });
    expect(s.score).toBeNull();
    expect(s.applicable).toBe(false);
    expect(s.facts.bookingOpensOn).toBe("2027-01-15");
  });

  it("flags a stale cached quote and lowers confidence", () => {
    const stale = new Date(NOW.getTime() - 48 * 3_600_000).toISOString();
    const s = scoreFlight({
      kind: "quote",
      quote: { ...baseQuote, fetchedAt: stale },
    });
    expect(s.drivers).toContain("flight.driver.staleQuote");
    expect(s.confidence).toBe("medium");
  });
});

/* ------------------------------------------------------------------- crowd */

describe("crowd", () => {
  const obon: Holiday[] = [
    { date: "2026-09-28", country: "JP", name: { en: "Test Peak", zh: "测试" }, weight: "peak" },
  ];

  it("reproduces the worked example: a plain weekend-only trip scores ~90", () => {
    /**
     * PLANS asserts 90 here while also stating "only weekends, no holidays",
     * which leaves no room for the weekend penalty the same sentence implies.
     * The model counts weekends explicitly (0.3 of a holiday day each), so a
     * 5-day trip containing one weekend lands at ~98. The ordering and the
     * direction are what matter; the absolute anchor was not self-consistent.
     */
    const s = scoreCrowd([], TRIP);
    expect(s.score).toBeGreaterThanOrEqual(95);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.drivers).toContain("crowd.driver.noHolidays");
  });

  it("lowers the score as holidays accumulate", () => {
    const none = scoreCrowd([], TRIP).score as number;
    const one = scoreCrowd(
      [{ date: "2026-09-25", country: "JP", name: { en: "H", zh: "节" }, weight: "normal" }],
      TRIP,
    ).score as number;
    const three = scoreCrowd(
      ["2026-09-25", "2026-09-28", "2026-09-29"].map((date) => ({
        date,
        country: "JP",
        name: { en: "H", zh: "节" },
        weight: "normal" as const,
      })),
      TRIP,
    ).score as number;
    expect(one).toBeLessThan(none);
    expect(three).toBeLessThan(one);
  });

  it("treats a peak run as worse than the same holidays spread out", () => {
    const consecutive = scoreCrowd(
      ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"].map((date) => ({
        date,
        country: "JP",
        name: { en: "Golden Week", zh: "黄金周" },
        weight: "peak" as const,
      })),
      TRIP,
    );
    expect(consecutive.drivers).toContain("crowd.driver.peakRun");
    expect(consecutive.facts.longestPeakRun).toBeGreaterThanOrEqual(4);
  });

  it("ignores holidays in the wrong country", () => {
    const cn = scoreCrowd(
      [{ date: "2026-09-25", country: "CN", name: { en: "CN", zh: "中" }, weight: "peak" }],
      TRIP,
    );
    expect(cn.score).toBe(scoreCrowd([], TRIP).score);
  });

  it("counts weekends in the pressure analysis", () => {
    const a = analyseCrowding([], "2026-09-25", "2026-09-29", "JP");
    expect(a.tripDays).toBe(5);
    expect(a.weekendDays).toBe(2); // Sat 26th, Sun 27th
    expect(a.holidayPressureDays).toBeCloseTo(0.6, 5);
  });

  it("always states that crowding is a proxy, not a measurement", () => {
    expect(scoreCrowd([], TRIP).drivers).toContain("crowd.driver.proxyOnly");
  });
});

/* ---------------------------------------------------------------------- fx */

describe("scoreFx", () => {
  const snapshot = (rate: number): FxSnapshot => ({
    from: "CNY",
    to: "JPY",
    rate,
    yearLow: 17.5,
    yearHigh: 24.2,
    asOf: "2026-09-22T00:00:00Z",
  });

  it("gives 100 at a 12-month high and 25 at a 12-month low", () => {
    expect(scoreFx(snapshot(24.2)).score).toBe(100);
    expect(scoreFx(snapshot(17.5)).score).toBe(25);
  });

  it("reproduces the worked example and explains why it differs from 88", () => {
    /**
     * PLANS example: CNY/JPY 23.51, 12-month high 24.2, asserted score 88.
     * The spec's own rule text ("closer to the year high scores higher") would
     * give 97, so the asserted 88 matches neither the rule nor a normalised
     * position. Scoring the position inside the pair's own range gives 92.3.
     */
    const s = scoreFx(snapshot(23.51));
    expect(s.score).toBeCloseTo(92.3, 1);
    expect(s.drivers).toContain("fx.driver.nearYearHigh");
    expect(s.facts.positionInRange).toBe(90);
  });

  it("states the direction, because high-rate-is-good is counter-intuitive", () => {
    expect(scoreFx(snapshot(23.51)).drivers).toContain(
      "fx.driver.higherIsBetter",
    );
  });

  it("is not applicable for same-currency trips and never scores 0", () => {
    const s = scoreFx(null);
    expect(s.score).toBeNull();
    expect(s.applicable).toBe(false);
    expect(s.drivers).toContain("fx.driver.sameCurrency");
  });

  it("treats a pegged pair as low confidence and neutral", () => {
    const pegged = scoreFx({
      from: "CNY",
      to: "HKD",
      rate: 1.1,
      yearLow: 1.095,
      yearHigh: 1.105,
      asOf: "2026-09-22T00:00:00Z",
    });
    expect(pegged.confidence).toBe("low");
    expect(pegged.drivers).toContain("fx.driver.flatRange");
  });

  it("raises confidence for a wide-ranging pair", () => {
    expect(scoreFx(snapshot(23.51)).confidence).toBe("high");
  });
});

/* ------------------------------------------------------------------- total */

describe("computeTotal", () => {
  const all = (n: number, keys: DimensionScore["key"][] = [
    "weather",
    "hotel",
    "flight",
    "crowd",
    "fx",
  ]) => keys.map((k) => dim(k, n));

  it("returns the score itself when every dimension agrees", () => {
    expect(computeTotal(all(80)).total).toBe(80);
    expect(computeTotal(all(80)).arithmeticMean).toBe(80);
  });

  it("pulls the total below the arithmetic mean when dimensions are lopsided", () => {
    const { total, arithmeticMean } = computeTotal([
      dim("weather", 100),
      dim("hotel", 100),
      dim("flight", 20),
      dim("crowd", 100),
      dim("fx", 100),
    ]);
    expect(arithmeticMean).toBe(84);
    expect(total).toBeLessThan(arithmeticMean);
  });

  it("caps the total when one dimension is a dealbreaker", () => {
    const result = computeTotal([
      dim("weather", 100),
      dim("hotel", 100),
      dim("flight", 35),
      dim("crowd", 100),
      dim("fx", 100),
    ]);
    expect(result.cappedBy).toBe("flight");
    expect(result.total).toBeLessThanOrEqual(PARAMS.total.weakDimensionCap);
  });

  it("excludes not-applicable dimensions and redistributes their weight", () => {
    const withFx = computeTotal(all(80));
    const withoutFx = computeTotal([
      dim("weather", 80),
      dim("hotel", 80),
      dim("flight", 80),
      dim("crowd", 80),
      dim("fx", null),
    ]);
    expect(withoutFx.total).toBe(withFx.total);
    expect(withoutFx.arithmeticMean).toBe(80);
  });

  it("ranks attribution by weighted impact", () => {
    const { attribution } = computeTotal([
      dim("weather", 100),
      dim("hotel", 50),
      dim("flight", 30),
      dim("crowd", 100),
      dim("fx", 100),
    ]);
    expect(attribution[0].key).toBe("flight");
    expect(attribution[1].key).toBe("hotel");
  });

  it("survives a zero score without collapsing the log", () => {
    const { total } = computeTotal(all(0));
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------- end-to-end trip scoring */

describe("scoreTrip", () => {
  const context = {
    weather: {
      date: "2026-09-25",
      basis: "forecast",
      tempC: 25,
      humidityPct: 50,
      tempSpreadC: 2,
      humiditySpreadPct: 8,
    } satisfies WeatherSample,
    hotel: {
      perNightLocal: 1000,
      baselineLocal: 500,
      confidence: 0.8,
      basis: "chain-direct-median",
      sampleSize: 20,
    } satisfies HotelQuote,
    flight: {
      kind: "quote",
      quote: {
        basis: "cached-fare",
        fareLocal: 635,
        fetchedAt: NOW.toISOString(),
        confidence: 0.7,
        distanceModel: {
          roundTripMiles: 2164,
          dollarsPerMile: 0.1,
          theoreticalUsd: 216.4,
          theoreticalLocal: 216.4,
          localPerUsd: 7.1,
        },
      },
    } as const,
    holidays: [
      {
        date: "2026-09-28",
        country: "JP",
        name: { en: "Test", zh: "测试" },
        weight: "peak",
      },
    ] satisfies Holiday[],
    fx: {
      from: "CNY",
      to: "JPY",
      rate: 23.51,
      yearLow: 17.5,
      yearHigh: 24.2,
      asOf: "2026-09-22T00:00:00Z",
    } satisfies FxSnapshot,
    computedAt: NOW.toISOString(),
  };

  it("produces a complete, explainable result", () => {
    const r = scoreTrip(TRIP, context);
    expect(r.dimensions).toHaveLength(5);
    expect(r.total).toBeGreaterThan(0);
    expect(r.total).toBeLessThanOrEqual(100);
    expect(r.tripDays).toBe(5);
    expect(r.attribution.length).toBeGreaterThan(0);
    for (const d of r.dimensions) {
      expect(d.drivers.length).toBeGreaterThan(0);
    }
  });

  it("surfaces a warning whenever a low-confidence dimension is involved", () => {
    const r = scoreTrip(TRIP, {
      ...context,
      weather: {
        ...context.weather,
        basis: "climate-normal",
        date: "2026-12-01",
      },
    });
    expect(r.warnings).toContain("warning.weatherIsClimateNormal");
    expect(r.warnings).toContain("warning.lowConfidenceDimensions");
  });

  it("reworks the total when a fare is unavailable rather than scoring it zero", () => {
    const withFlight = scoreTrip(TRIP, context);
    const withoutFlight = scoreTrip(TRIP, {
      ...context,
      flight: { kind: "unavailable", reason: "outside-booking-window" },
    });
    expect(withoutFlight.warnings).toContain("warning.flightUnavailable");
    expect(withoutFlight.total).not.toBe(0);
    expect(withoutFlight.total).not.toBe(withFlight.total);
  });

  it("warns on a same-currency trip", () => {
    const r = scoreTrip(
      { ...TRIP, destination: { ...HND, country: "CN", currency: "CNY" } },
      { ...context, fx: null },
    );
    expect(r.warnings).toContain("warning.sameCurrency");
  });

  it("is deterministic", () => {
    expect(scoreTrip(TRIP, context)).toEqual(scoreTrip(TRIP, context));
  });
});

/* ----------------------------------------------------------------- helpers */

describe("clamp", () => {
  it("bounds values", () => {
    expect(clamp(-5)).toBe(0);
    expect(clamp(105)).toBe(100);
    expect(clamp(50)).toBe(50);
    expect(clamp(50, 10, 20)).toBe(20);
  });
});
