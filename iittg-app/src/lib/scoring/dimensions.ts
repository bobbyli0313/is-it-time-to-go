/**
 * Dimension scorers.
 *
 * Every function here is pure and synchronous: data acquisition is a separate
 * concern (see `lib/data`). That split is deliberate — it is what lets the whole
 * scoring model be tested against fixtures without a network.
 *
 * Each scorer returns i18n *keys*, never prose, so the same score can be
 * rendered in any locale.
 */

import {
  addDays,
  diffDays,
  enumerateDates,
  isWeekend,
  parseIsoDate,
  tripLengthDays,
  todayForTrip,
} from "./dates";
import type {
  City,
  Confidence,
  DimensionScore,
  FlightQuote,
  FlightScorerInput,
  FxSnapshot,
  Holiday,
  HotelQuote,
  TripInput,
  WeatherSample,
} from "./types";

/* ------------------------------------------------------- tunable constants */

/**
 * All magic numbers live here, in one place, so they can be argued about and
 * tuned without hunting through logic. See MODEL.md for the calibration notes.
 */
export const PARAMS = {
  weather: {
    idealTempC: 25,
    idealHumidityPct: 50,
    /** °C of deviation at which the weather score falls to ~1/e^2 (≈13.5). */
    tempScaleC: 14,
    /** percentage points of deviation at which the score falls to ~1/e^2. */
    humidityScalePct: 30,
    /** Relative importance of temperature vs humidity inside the weather score. */
    tempWeight: 0.6,
    /** Beyond this many days out, a "forecast" is treated as low confidence. */
    forecastHighConfidenceDays: 7,
    /** Edge of the trustworthy numerical forecast window. */
    forecastMaxDays: 14,
  },
  hotel: {
    /** Baseline nightly rate, in CNY, that scores a perfect 100. */
    baselineCny: 500,
    /**
     * Fitted so an index at exactly 2x baseline scores 70 — the one hotel data
     * point the original product brief provides ("Tokyo 1000/night -> 70"). The
     * brief gave no formula, so this anchor is what pins the curve down:
     * 1x -> 100, 1.5x -> ~84, 2x -> 70, 3x -> ~49, 4x -> ~34.
     *
     * The brief is a private planning note and is not part of this repository;
     * MODEL.md records the same calibration publicly.
     */
    decay: 0.356675,
    /**
     * With fewer than this many properties behind the index, confidence drops.
     * The index is only ever a *relative* signal, never a bookable rate.
     */
    minSampleForHighConfidence: 12,
  },
  flight: {
    /** A fare at the 0th percentile of history scores 100; the 90th scores 0. */
    percentileAtZeroScore: 90,
    /** Price / theoretical-distance-price ratio at which the built-in penalty starts. */
    distanceRatioThreshold: 1,
    /**
     * Fitted so a fare at 2.93x the `miles x $0.10` anchor scores ~20, matching
     * the original brief's worked example. Note that brief's own numbers are
     * internally inconsistent here: the stated rule "miles x $0.10, and the more
     * expensive the lower the score" admits no decay coefficient that is also
     * obviously "correct", so this is fitted to the example rather than derived.
     *
     * This is the *fallback* path only: when route history exists, scoring is
     * percentile-based and this constant is unused. MODEL.md documents the
     * calibration publicly; the brief itself is a private note, not in this repo.
     */
    distanceDecay: 0.85,
    /** Cached quotes older than this many hours are flagged stale in the UI. */
    staleAfterHours: 24,
  },
  crowd: {
    /** Points lost per (person-count × day) of holiday pressure. */
    pointsPerPressureDay: 3,
    /** A plain weekend day is worth this fraction of a holiday-pressure day. */
    weekendWeight: 0.3,
    /** How heavily each holiday weight class counts. */
    holidayWeight: { peak: 1.5, normal: 1, minor: 0.4 },
    /** Consecutive peak days at or above this count are called out as a peak run. */
    peakRunMinDays: 3,
  },
  fx: {
    /** A new 12-month high for the origin currency scores 100. */
    newHighScore: 100,
    /** A 12-month low scores this — itself a strong signal to hold off. */
    newLowScore: 25,
    /**
     * A pair whose 12-month range is narrower than this fraction of its midpoint
     * is treated as managed/pegged. Set at 1.2% so a genuinely banded currency
     * (CNY/HKD moves ~0.9% a year) reads as flat rather than being scored as if
     * its tiny movements were a real signal.
     */
    flatRangePct: 0.012,
    /** Spread above this fraction (of the midpoint) earns a confidence bonus. */
    wideRangePct: 0.08,
  },
  total: {
    /** Per-dimension weights. Equal by default; surfaced in the UI. */
    weights: { weather: 0.2, hotel: 0.2, flight: 0.2, crowd: 0.2, fx: 0.2 },
    /**
     * Exponent of the weighted power mean used to combine dimensions.
     * 1.0 = arithmetic mean (no penalty for lopsidedness, the original spec).
     * 0.5 = square-root mean, the default: a mild, monotone penalty for one
     *       catastrophic dimension dragging an otherwise good trip down.
     * -> 0 = geometric mean, maximally harsh; rejected as too punishing.
     */
    powerMeanExponent: 0.5,
    /** Any dimension at or below this score caps the overall total. */
    weakDimensionThreshold: 40,
    weakDimensionCap: 60,
    /** Floor applied to a single dimension, so one bad input cannot zero the trip. */
    minDimensionScore: 5,
  },
} as const;

/* ---------------------------------------------------------------- helpers */

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

/** Gaussian-shaped "closeness" score: 100 at zero deviation, ~0 far away. */
function closeness(deviation: number, scale: number): number {
  const z = deviation / scale;
  return 100 * Math.exp(-z * z);
}

function confidenceFromNumber(value: number): Confidence {
  if (value >= 0.66) return "high";
  if (value >= 0.4) return "medium";
  return "low";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ---------------------------------------------------------------- weather */

export function scoreWeather(
  sample: WeatherSample,
  trip: Pick<TripInput, "origin" | "destination" | "departDate">,
  now: Date = new Date(),
): DimensionScore {
  const p = PARAMS.weather;

  const tempScore = closeness(
    Math.abs(sample.tempC - p.idealTempC),
    p.tempScaleC,
  );
  const humidityScore = closeness(
    Math.abs(sample.humidityPct - p.idealHumidityPct),
    p.humidityScalePct,
  );

  const score = round1(
    tempScore * p.tempWeight + humidityScore * (1 - p.tempWeight),
  );

  /**
   * Lead time is measured from the trip's own reference "today", which is the
   * later of the two cities' dates. The data provider decides forecast-vs-normal
   * from the destination's clock, so measuring from anywhere else here would let
   * the confidence label disagree with the data it is labelling.
   */
  const daysOut = diffDays(
    todayForTrip(trip.origin.timezone, trip.destination.timezone, now),
    sample.date,
  );

  /**
   * Confidence is driven by *provenance plus horizon*, not by how pleasant the
   * number looks. A climate normal can never be high confidence, however close
   * its average happens to sit to the ideal.
   */
  let confidence: Confidence;
  if (sample.basis === "forecast") {
    confidence =
      daysOut <= p.forecastHighConfidenceDays ? "high" : "medium";
  } else {
    confidence = daysOut <= 30 ? "medium" : "low";
  }

  const drivers: string[] = [];
  if (tempScore >= 85) drivers.push("weather.driver.tempIdeal");
  else if (sample.tempC > p.idealTempC) drivers.push("weather.driver.tempHot");
  else drivers.push("weather.driver.tempCold");

  if (humidityScore >= 85) drivers.push("weather.driver.humidityIdeal");
  else if (sample.humidityPct > p.idealHumidityPct)
    drivers.push("weather.driver.humidityHumid");
  else drivers.push("weather.driver.humidityDry");

  drivers.push(
    sample.basis === "forecast"
      ? "weather.driver.forecast"
      : "weather.driver.climateNormal",
  );

  return {
    key: "weather",
    score,
    applicable: true,
    confidence,
    weight: PARAMS.total.weights.weather,
    facts: {
      date: sample.date,
      basis: sample.basis,
      tempC: sample.tempC,
      humidityPct: sample.humidityPct,
      ...(sample.basis === "climate-normal"
        ? {
            tempSpreadC: sample.tempSpreadC,
            humiditySpreadPct: sample.humiditySpreadPct,
          }
        : {}),
      ...(sample.precipProbabilityPct !== undefined
        ? { precipProbabilityPct: sample.precipProbabilityPct }
        : {}),
    },
    drivers,
    debug: {
      tempScore: round1(tempScore),
      humidityScore: round1(humidityScore),
      daysOut,
      // Single-day sampling cannot represent a multi-day trip; disclosed, not hidden.
      sampledDate: sample.date,
    },
  };
}

/* ------------------------------------------------------------------ hotel */

/**
 * Scores a city's collected median nightly rate against the ¥500 anchor.
 *
 * Non-linear in the ratio to the baseline: doubling the price costs 30 points,
 * tripling costs ~48, so the score degrades quickly but never collapses to zero
 * while a destination remains merely expensive rather than absurd.
 *
 * The input is a *level* — the median across the city's collected hotels — not a
 * relative index. What keeps the number honest is disclosed rather than assumed:
 * how many properties are behind it, how many the city is known to have, and how
 * old the samples are.
 */
export function scoreHotel(quote: HotelQuote): DimensionScore {
  const p = PARAMS.hotel;

  /**
   * No price is not a cheap price.
   *
   * A city the collector has not covered arrives as a zero-confidence quote with no
   * amount. Scoring it produced `0 / 0` — NaN — which raised the total to NaN and
   * serialised as `"total": null` in the API response. It is excluded instead, exactly
   * as an unsold fare is, and the remaining weights redistribute over the dimensions
   * that do have data.
   */
  if (quote.sampleSize === 0 || !(quote.perNightLocal > 0) || !(quote.baselineLocal > 0)) {
    return {
      key: "hotel",
      score: null,
      applicable: false,
      // "High" confidence in the *absence*, mirroring the unavailable-fare branch: the
      // reason is known rather than uncertain.
      confidence: "high",
      weight: PARAMS.total.weights.hotel,
      facts: {
        basis: quote.basis,
        unavailable: "not-collected",
        disclaimer: "fact.medianNotBookable",
      },
      drivers: [
        quote.basis === "collected-median"
          ? "hotel.driver.notCollected"
          : "hotel.driver.mockFlat",
      ],
      debug: undefined,
    };
  }

  const index = quote.perNightLocal / quote.baselineLocal;
  // Deviation is clamped at 0: at or below baseline is full marks, per spec.
  const deviation = Math.max(0, index - 1);
  const score = round1(
    clamp(
      100 * Math.exp(-p.decay * deviation),
      PARAMS.total.minDimensionScore,
    ),
  );

  let confidenceValue = quote.confidence;
  if (quote.sampleSize < p.minSampleForHighConfidence) {
    confidenceValue = Math.min(confidenceValue, 0.55);
  }
  /**
   * A stale level is a claim about a past market. It is not hidden and it is not
   * treated as a failure — the number is still the best available — but it cannot
   * carry the confidence a fresh one does.
   */
  if (quote.stale) confidenceValue = Math.min(confidenceValue, 0.35);

  const drivers: string[] = [
    quote.basis === "collected-median"
      ? "hotel.driver.collectedMedian"
      : "hotel.driver.mockFlat",
  ];
  if (index <= 1) drivers.push("hotel.driver.belowBaseline");
  else if (index >= 1.6) drivers.push("hotel.driver.farAboveBaseline");
  else drivers.push("hotel.driver.aboveBaseline");
  if (quote.sampleSize < p.minSampleForHighConfidence) {
    drivers.push("hotel.driver.thinSample");
  }
  if (quote.stale) drivers.push("hotel.driver.staleSamples");
  if (quote.disclosure === "index") drivers.push("hotel.driver.indexOnly");

  /**
   * Index-only disclosure.
   *
   * A source that permits storing a rate but not republishing it still has to be
   * scorable — the score only needs the *ratio*, the user only needs to know whether
   * the city is expensive relative to the ¥500 anchor. So the amounts are removed
   * here, in the layer whose output becomes the API response: omitting them in a
   * component would leave them in the JSON.
   */
  const indexOnly = quote.disclosure === "index";
  const distancePct = Math.round((index - 1) * 1000) / 10;

  return {
    key: "hotel",
    score,
    applicable: true,
    confidence: confidenceFromNumber(confidenceValue),
    weight: PARAMS.total.weights.hotel,
    facts: {
      // Fact keys *are* i18n key suffixes — see the contract in `messages.test.ts`.
      basis: quote.basis,
      ...(indexOnly
        ? {
            disclosure: "index" as const,
            indexPctVsBaseline: distancePct,
          }
        : {
            disclosure: "price" as const,
            perNight: Math.round(quote.perNightLocal),
            baseline: Math.round(quote.baselineLocal),
            /**
             * The ratio is only published alongside the amounts, never in index mode:
             * a ratio times the ¥500 anchor recovers the price, so emitting it would
             * publish exactly what the source forbids.
             */
            index: round1(index * 100) / 100,
          }),
      sampleSize: quote.sampleSize,
      ...(quote.propertyUniverse !== undefined
        ? { propertyUniverse: quote.propertyUniverse }
        : {}),
      ...(quote.collectedAt ? { collectedAt: quote.collectedAt } : {}),
      ...(quote.components
        ? {
            holidayLift: quote.components.holidayLift,
            seasonalFactor: quote.components.seasonal,
            nearbyHolidayDays: quote.components.nearbyHolidayDays,
          }
        : {}),
      /** Stated plainly in the UI: a collected median is not a booking price. */
      disclaimer: "fact.medianNotBookable",
    },
    drivers,
    debug: {
      deviation: round1(deviation * 100) / 100,
      stale: quote.stale ? 1 : 0,
    },
  };
}

/* ----------------------------------------------------------------- flight */

/**
 * Scores a fare primarily by its *percentile within the route's own history*,
 * which is stable across routes. The distance model
 * (`miles × $0.10/mile`) is kept as a fallback and as a cross-check, because it
 * is the only signal available when no history has been collected yet.
 */
/**
 * Accepts either a real quote or a typed "no fare available" reason. The
 * unavailable branch yields `applicable: false`, which removes the dimension
 * from the total instead of silently scoring it as zero.
 */
export function scoreFlight(input: FlightScorerInput): DimensionScore {
  const p = PARAMS.flight;
  const weight = PARAMS.total.weights.flight;
  const base = { key: "flight" as const, weight };

  if (input.kind === "unavailable") {
    return {
      ...base,
      score: null,
      applicable: false,
      confidence: "high",
      facts: {
        unavailable: input.reason,
        ...(input.bookingOpensOn ? { bookingOpensOn: input.bookingOpensOn } : {}),
      },
      drivers: [
        input.reason === "outside-booking-window"
          ? "flight.driver.outsideBookingWindow"
          : "flight.driver.noQuote",
      ],
      debug: undefined,
    };
  }

  const quote = input.quote;
  const history = quote.history;

  let score: number;
  let drivers: string[] = [];

  if (history && history.max > history.min) {
    // Percentile path: cheaper than usual is good, independent of route length.
    const rank = clamp(history.percentile, 0, 100);
    score = round1(
      clamp(100 - (rank / p.percentileAtZeroScore) * 100),
    );
    drivers.push("flight.driver.percentile");
    if (quote.fareLocal <= history.min * 1.02) drivers.push("flight.driver.newLow");
    else if (rank <= 25) drivers.push("flight.driver.cheapVsHistory");
    else if (rank >= 75) drivers.push("flight.driver.expensiveVsHistory");
    else drivers.push("flight.driver.typicalVsHistory");
  } else {
    /**
     * Distance-model fallback: the brief's `miles x $0.10` anchor.
     *
     * The anchor is denominated in USD, so it must be converted into the fare's own
     * currency before the two are divided. An earlier version compared them directly,
     * which scored a CNY fare of 3,009 against a USD anchor of 218 as 13.8x the
     * theoretical price on a route whose real ratio was about 2x — a wrong number,
     * presented with full confidence.
     *
     * When no rate is available `theoreticalLocal` is absent and the ratio is not
     * computed at all: the dimension is excluded rather than scored against the wrong
     * unit.
     */
    const anchor = quote.distanceModel.theoreticalLocal;
    if (anchor === undefined || anchor <= 0) {
      return {
        key: "flight",
        score: null,
        applicable: false,
        confidence: "low",
        weight: PARAMS.total.weights.flight,
        facts: {
          basis: quote.basis,
          unavailable: "no-fx-for-anchor",
          theoreticalUsd: round1(quote.distanceModel.theoreticalUsd),
        },
        drivers: ["flight.driver.noFxForAnchor"],
      };
    }

    const ratio = quote.fareLocal / anchor;
    const excess = Math.max(0, ratio - p.distanceRatioThreshold);
    score = round1(
      clamp(
        100 * Math.exp(-p.distanceDecay * excess),
        PARAMS.total.minDimensionScore,
      ),
    );
    drivers.push("flight.driver.distanceModel");
    if (excess === 0) drivers.push("flight.driver.atOrBelowTheoretical");
    else drivers.push("flight.driver.aboveTheoretical");
  }

  if (quote.basis === "blended") drivers.push("flight.driver.blended");

  const fetchedAt = new Date(quote.fetchedAt).getTime();
  const ageHours = Number.isFinite(fetchedAt)
    ? (Date.now() - fetchedAt) / 3_600_000
    : Number.POSITIVE_INFINITY;
  if (ageHours > p.staleAfterHours) drivers.push("flight.driver.staleQuote");

  const confidenceValue = Math.min(
    quote.confidence,
    ageHours > p.staleAfterHours ? 0.5 : 1,
  );

  return {
    ...base,
    score,
    applicable: true,
    confidence: confidenceFromNumber(confidenceValue),
    facts: {
      basis: quote.basis,
      fareLocal: Math.round(quote.fareLocal),
      fetchedAt: quote.fetchedAt,
      ageHours: Math.round(ageHours * 10) / 10,
      theoreticalUsd: round1(quote.distanceModel.theoreticalUsd),
      ...(quote.distanceModel.theoreticalLocal !== undefined
        ? {
            theoreticalLocal: round1(quote.distanceModel.theoreticalLocal),
            fareToTheoreticalRatio:
              Math.round(
                (quote.fareLocal / quote.distanceModel.theoreticalLocal) * 100,
              ) / 100,
          }
        : {}),
      ...(history
        ? {
            historyMin: Math.round(history.min),
            historyMedian: Math.round(history.median),
            historyMax: Math.round(history.max),
            percentile: Math.round(history.percentile),
            lookbackDays: history.lookbackDays,
          }
        : {}),
    },
    drivers,
    debug: undefined,
  };
}

/* ------------------------------------------------------------------ crowd */

export interface CrowdAnalysis {
  /** Sum of (weight × days) contributed by public holidays. */
  holidayPressureDays: number;
  /** Longest consecutive run of peak-class holiday/weekend days. */
  longestPeakRun: number;
  weekendDays: number;
  tripDays: number;
  holidayDates: string[];
}

/**
 * Public holidays are a *proxy* for crowding, not a measurement of it. Tourist
 * arrivals and flight load factors have no public API, so this dimension is
 * named "crowding estimate" throughout the UI rather than "foot traffic".
 */
export function analyseCrowding(
  holidays: Holiday[],
  departDate: string,
  returnDate: string,
  country: string,
): CrowdAnalysis {
  const p = PARAMS.crowd;
  const days = enumerateDates(departDate, returnDate);
  const holidayByDate = new Map<string, Holiday>();

  for (const h of holidays) {
    if (h.country !== country) continue;
    // If two holidays share a date, keep the heavier one.
    const existing = holidayByDate.get(h.date);
    if (
      !existing ||
      p.holidayWeight[h.weight] > p.holidayWeight[existing.weight]
    ) {
      holidayByDate.set(h.date, h);
    }
  }

  let holidayPressureDays = 0;
  let weekendDays = 0;
  let longestPeakRun = 0;
  let currentRun = 0;
  const holidayDates: string[] = [];

  for (const date of days) {
    const holiday = holidayByDate.get(date);
    const weekend = isWeekend(date);
    if (weekend) weekendDays += 1;

    if (holiday) {
      holidayDates.push(date);
      holidayPressureDays += p.holidayWeight[holiday.weight];
    } else if (weekend) {
      holidayPressureDays += p.weekendWeight;
    }

    // "Peak congestion" = peak-class holiday, or a weekend swallowed by one.
    const isPeak = holiday
      ? holiday.weight === "peak"
      : weekend && holidayByDate.has(addDays(date, -1));
    currentRun = isPeak ? currentRun + 1 : 0;
    longestPeakRun = Math.max(longestPeakRun, currentRun);
  }

  return {
    holidayPressureDays: Math.round(holidayPressureDays * 100) / 100,
    longestPeakRun,
    weekendDays,
    tripDays: days.length,
    holidayDates,
  };
}

export function scoreCrowd(
  holidays: Holiday[],
  trip: Pick<TripInput, "destination" | "departDate" | "returnDate">,
): DimensionScore {
  const p = PARAMS.crowd;
  const analysis = analyseCrowding(
    holidays,
    trip.departDate,
    trip.returnDate,
    trip.destination.country,
  );

  let score = 100 - analysis.holidayPressureDays * p.pointsPerPressureDay;

  // A run of consecutive peak days is worse than the same days spread out.
  if (analysis.longestPeakRun >= p.peakRunMinDays) {
    score -= (analysis.longestPeakRun - p.peakRunMinDays + 1) * 5;
  }
  score = round1(clamp(score));

  const drivers: string[] = [];
  if (analysis.holidayDates.length === 0) drivers.push("crowd.driver.noHolidays");
  else drivers.push("crowd.driver.hasHolidays");
  if (analysis.longestPeakRun >= p.peakRunMinDays)
    drivers.push("crowd.driver.peakRun");
  if (analysis.weekendDays > 0) drivers.push("crowd.driver.weekendsCounted");
  // Stated every time: this is a holiday proxy, not measured foot traffic.
  drivers.push("crowd.driver.proxyOnly");

  return {
    key: "crowd",
    score,
    applicable: true,
    confidence: "medium",
    weight: PARAMS.total.weights.crowd,
    facts: {
      holidayCount: analysis.holidayDates.length,
      holidayPressureDays: analysis.holidayPressureDays,
      longestPeakRun: analysis.longestPeakRun,
      weekendDays: analysis.weekendDays,
      tripDays: analysis.tripDays,
      holidayDates: analysis.holidayDates.join(","),
    },
    drivers,
    debug: undefined,
  };
}

/* --------------------------------------------------------------------- fx */

/**
 * Scores where today's rate sits *within the past year's own range*.
 *
 * Direction, stated explicitly because it is counter-intuitive: a HIGH rate
 * means one unit of origin currency buys MORE destination currency, which is
 * good for the traveller. So a 12-month high scores 100 and a 12-month low
 * scores 25.
 *
 * Normalising by the pair's own range (rather than a fixed percentage) means a
 * volatile pair like CNY/JPY and a pegged one like CNY/HKD are both scored on
 * how favourable today is *relative to what this pair normally does*.
 */
export function scoreFx(fx: FxSnapshot | null): DimensionScore {
  const p = PARAMS.fx;
  const weight = PARAMS.total.weights.fx;

  if (!fx) {
    return {
      key: "fx",
      score: null,
      applicable: false,
      confidence: "high",
      weight,
      facts: { unavailable: "same-currency" },
      drivers: ["fx.driver.sameCurrency"],
      debug: undefined,
    };
  }

  const range = fx.yearHigh - fx.yearLow;
  const midpoint = (fx.yearHigh + fx.yearLow) / 2 || 1;
  const flat = range / midpoint < p.flatRangePct;

  let ratio: number;
  if (flat) {
    // Pegged or effectively fixed: one rate is as good as another.
    ratio = 1;
  } else {
    ratio = clamp((fx.rate - fx.yearLow) / range, 0, 1);
  }

  const score = round1(
    clamp(
      p.newLowScore + ratio * (p.newHighScore - p.newLowScore),
    ),
  );

  const confidence: Confidence = flat
    ? "low"
    : range / midpoint >= p.wideRangePct
      ? "high"
      : "medium";

  const drivers: string[] = [];
  if (flat) drivers.push("fx.driver.flatRange");
  else if (ratio >= 0.85) drivers.push("fx.driver.nearYearHigh");
  else if (ratio <= 0.15) drivers.push("fx.driver.nearYearLow");
  else drivers.push("fx.driver.midRange");
  drivers.push("fx.driver.higherIsBetter");

  return {
    key: "fx",
    score,
    applicable: true,
    confidence,
    weight,
    facts: {
      from: fx.from,
      to: fx.to,
      rate: Math.round(fx.rate * 10000) / 10000,
      yearLow: Math.round(fx.yearLow * 10000) / 10000,
      yearHigh: Math.round(fx.yearHigh * 10000) / 10000,
      rangePct: Math.round((range / midpoint) * 1000) / 10,
      asOf: fx.asOf,
      positionInRange: Math.round(ratio * 100),
    },
    drivers,
    debug: undefined,
  };
}

/** Baseline nightly rate converted into the destination's own currency. */
export function hotelBaselineLocal(
  destination: City,
  cnyPerUnitLocal: number,
): number {
  // cnyPerUnitLocal = how many CNY one unit of the local currency is worth.
  return PARAMS.hotel.baselineCny / cnyPerUnitLocal;
}

/** Re-exported so callers do not need to reach into `dates` for trip length. */
export { tripLengthDays, parseIsoDate };
