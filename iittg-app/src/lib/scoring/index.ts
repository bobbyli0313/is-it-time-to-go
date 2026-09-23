/**
 * Total-score orchestration.
 *
 * Two deliberate departures from the original spec, both to fix real failure
 * modes of a plain arithmetic mean over five incommensurable dimensions:
 *
 * 1. A weighted *power mean* instead of the arithmetic mean. With a plain
 *    average, one catastrophic dimension (a fare at 3x normal) is averaged away
 *    by four good ones, and the user is told a trip is fine when it is not. The
 *    exponent is calibrated rather than guessed (see `powerMeanExponent`): a
 *    pure geometric mean turned out to be far too punishing, collapsing an
 *    otherwise-good trip to ~49 because of one bad fare. The square-root mean
 *    keeps the ordering and the penalty but stays interpretable.
 * 2. A cap: if any applicable dimension scores at or below
 *    `weakDimensionThreshold`, the total cannot exceed `weakDimensionCap`. This
 *    makes the arithmetic mean's masking impossible to hide.
 *
 * The arithmetic mean is still computed and returned, so the UI can show both
 * numbers side by side and the user can see exactly how much aggregation moved
 * the result.
 */

import {
  PARAMS,
  clamp,
  scoreCrowd,
  scoreFlight,
  scoreFx,
  scoreHotel,
  scoreWeather,
} from "./dimensions";
import { tripLengthDays } from "./dates";
import type {
  DimensionKey,
  DimensionScore,
  ScoreContext,
  ScoreResult,
  TripInput,
} from "./types";

/**
 * Re-exported so `lib/scoring` is the single public entry point for the model.
 * Consumers (and tests) should never need to reach into `dimensions` directly.
 */
export {
  PARAMS,
  clamp,
  analyseCrowding,
  scoreCrowd,
  scoreFlight,
  scoreFx,
  scoreHotel,
  scoreWeather,
  hotelBaselineLocal,
  type CrowdAnalysis,
} from "./dimensions";
export type {
  FlightScorerInput,
  FlightUnavailableReason,
} from "./types";
export {
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

/** Weights are normalised over *applicable* dimensions so N/A never dilutes. */
function distributeWeights(dimensions: DimensionScore[]): Map<DimensionKey, number> {
  const active = dimensions.filter((d) => d.applicable && d.score !== null);
  const totalWeight = active.reduce((sum, d) => sum + d.weight, 0);
  const out = new Map<DimensionKey, number>();
  for (const d of dimensions) {
    out.set(
      d.key,
      totalWeight > 0 && d.applicable && d.score !== null
        ? d.weight / totalWeight
        : 0,
    );
  }
  return out;
}

export function computeTotal(dimensions: DimensionScore[]): {
  total: number;
  arithmeticMean: number;
  cappedBy: DimensionKey | null;
  attribution: Array<{ key: DimensionKey; pointsLost: number }>;
} {
  const weights = distributeWeights(dimensions);
  const active = dimensions.filter((d) => d.applicable && d.score !== null);

  if (active.length === 0) {
    return { total: 0, arithmeticMean: 0, cappedBy: null, attribution: [] };
  }

  const exponent = PARAMS.total.powerMeanExponent;
  const floor = PARAMS.total.minDimensionScore;

  // Weighted power mean. With exponent 1 this is exactly the arithmetic mean;
  // below 1 it increasingly penalises dispersion across the dimensions.
  const weightedPowerSum = active.reduce((sum, d) => {
    const w = weights.get(d.key) ?? 0;
    const s = Math.max(d.score as number, floor);
    return sum + w * Math.pow(s, exponent);
  }, 0);
  let total = Math.pow(weightedPowerSum, 1 / exponent);

  const arithmeticMean =
    active.reduce((sum, d) => sum + (d.score as number), 0) / active.length;

  // Weak-dimension cap.
  let cappedBy: DimensionKey | null = null;
  const weakest = active.reduce(
    (min, d) => ((d.score as number) < (min.score as number) ? d : min),
    active[0],
  );
  if ((weakest.score as number) <= PARAMS.total.weakDimensionThreshold) {
    cappedBy = weakest.key;
    total = Math.min(total, PARAMS.total.weakDimensionCap);
  }

  // Attribution: how many points each dimension costs relative to a perfect 100,
  // scaled by its weight so it reflects impact on the total.
  const attribution = active
    .map((d) => ({
      key: d.key,
      pointsLost:
        Math.round(
          (100 - (d.score as number)) * (weights.get(d.key) ?? 0) * 10,
        ) / 10,
    }))
    .filter((a) => a.pointsLost > 0)
    .sort((a, b) => b.pointsLost - a.pointsLost);

  return {
    total: Math.round(clamp(total) * 10) / 10,
    arithmeticMean: Math.round(arithmeticMean * 10) / 10,
    cappedBy,
    attribution,
  };
}

/** Scores a fully-resolved trip. Pure: all data is passed in via `context`. */
export function scoreTrip(
  trip: TripInput,
  context: ScoreContext,
): ScoreResult {
  const dimensions: DimensionScore[] = [
    scoreWeather(context.weather, trip),
    scoreHotel(context.hotel),
    scoreFlight(context.flight),
    scoreCrowd(context.holidays, trip),
    scoreFx(context.fx),
  ];

  const { total, arithmeticMean, cappedBy, attribution } =
    computeTotal(dimensions);

  const warnings: string[] = [];

  const lowConfidence = dimensions.filter(
    (d) => d.applicable && d.confidence === "low",
  );
  if (lowConfidence.length > 0) {
    warnings.push("warning.lowConfidenceDimensions");
  }
  if (context.weather.basis === "climate-normal") {
    warnings.push("warning.weatherIsClimateNormal");
  }
  if (context.hotel.basis !== "hotel-price-index") {
    warnings.push("warning.hotelIsMock");
  }
  if (!context.flight || context.flight.kind === "unavailable") {
    warnings.push("warning.flightUnavailable");
  } else if (context.flight.quote.basis !== "cached-fare") {
    warnings.push("warning.flightNotCachedFare");
  }
  if (cappedBy) {
    warnings.push("warning.totalCappedByWeakDimension");
  }
  if (context.fx === null) {
    warnings.push("warning.sameCurrency");
  }

  return {
    total,
    arithmeticMean,
    cappedBy,
    dimensions,
    attribution,
    warnings,
    tripDays: tripLengthDays(trip.departDate, trip.returnDate),
  };
}
