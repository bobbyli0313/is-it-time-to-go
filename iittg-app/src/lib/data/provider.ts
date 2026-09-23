/**
 * Mock data provider — the seam where real APIs will eventually plug in.
 *
 * The public functions here are async and return the exact shapes the scoring
 * layer consumes (`ScoreContext` and friends). Swapping in Amadeus, Open-Meteo
 * and Nager.Date later means reimplementing these five functions and nothing
 * else: no component, scorer or test needs to change.
 *
 * Three rules the mock data deliberately obeys, because the real data does and
 * the UI must be built against reality from day one:
 *
 *  1. Weather is only a real forecast inside a short horizon. Beyond it we return
 *     a climate normal, tagged as such. The mock refuses to pretend.
 *  2. Fares are *cached* quotes with an age, and are unavailable entirely once
 *     the date falls outside the airline booking window.
 *  3. Hotels are a normalised price *index*, never a bookable nightly rate.
 */

import {
  addDays,
  diffDays,
  todayForTrip,
} from "../scoring/dates";
import type {
  City,
  FlightQuote,
  FlightUnavailableReason,
  FxSnapshot,
  Holiday,
  FlightScorerInput,
  HotelQuote,
  ScoreContext,
  TripInput,
  WeatherSample,
} from "../scoring/types";
import { findRoute } from "./routes";
import { CLIMATE, FX_VS_CNY, fxRateFor } from "./reference";
import { bellish, between, rngFor } from "./seed";
import { hasHolidayCoverage, holidaysInRange } from "./holidays";

/* --------------------------------------------------------------- settings */

export const MOCK_SETTINGS = {
  /** Numerical forecasts are only trustworthy this far out. */
  forecastHorizonDays: 14,
  /** Beyond the horizon we fall back to climate normals. */
  climateNormalHorizonDays: 90,
  /** Airlines typically open bookings ~330 days ahead. */
  bookingWindowDays: 330,
  /** Cached fares are considered stale after this many hours. */
  fareCacheTtlHours: 6,
  /** Round-trip fare lookback window used to build the percentile. */
  fareLookbackDays: 90,
  /** How many properties back the hotel price index. */
  hotelSampleSize: 18,
} as const;

/** Simulated latency, so loading states are exercised during development. */
const latency = () => new Promise((r) => setTimeout(r, 0));

/* ---------------------------------------------------------------- weather */

function monthIndex(iso: string): number {
  return Number(iso.slice(5, 7)) - 1;
}

export async function fetchWeather(
  destination: City,
  date: string,
  now: Date = new Date(),
): Promise<WeatherSample> {
  await latency();

  const climate = CLIMATE[destination.id];
  if (!climate) {
    throw new Error(`No climate reference data for ${destination.id}`);
  }

  /**
   * Must match the reference "today" used by `scoreWeather`, otherwise the
   * provider can hand back a forecast that the scorer then labels as a climate
   * normal (or vice versa).
   */
  const daysOut = diffDays(
    todayForTrip(destination.timezone, destination.timezone, now),
    date,
  );
  const month = climate.months[monthIndex(date)];
  const rng = rngFor("weather", destination.id, date);

  /**
   * Inside the horizon, produce a plausible *specific* forecast: a deviation
   * from the monthly mean that grows with lead time, which is how forecast
   * skill actually decays. Outside it, hand back the monthly normal honestly.
   */
  if (daysOut >= 0 && daysOut <= MOCK_SETTINGS.forecastHorizonDays) {
    const uncertainty = 1 + daysOut / 6;
    const tempC =
      Math.round((month.tempC + (bellish(rng) - 0.5) * 6 * uncertainty) * 10) /
      10;
    const humidityPct = Math.round(
      Math.min(
        98,
        Math.max(
          20,
          month.humidityPct + (bellish(rng) - 0.5) * 18 * uncertainty,
        ),
      ),
    );
    return {
      date,
      basis: "forecast",
      tempC,
      humidityPct,
      tempSpreadC: Math.round((2 + daysOut * 0.2) * 10) / 10,
      humiditySpreadPct: Math.round(6 + daysOut * 0.5),
      precipProbabilityPct: Math.round(
        Math.min(95, Math.max(0, (humidityPct - 45) * 1.6 + (rng() - 0.5) * 25)),
      ),
    };
  }

  // Climate normal: an average over many years, with the real spread disclosed.
  return {
    date,
    basis: "climate-normal",
    tempC: Math.round(month.tempC * 10) / 10,
    humidityPct: Math.round(month.humidityPct),
    tempSpreadC: climate.tempSpreadC,
    humiditySpreadPct: climate.humiditySpreadPct,
  };
}

/* ------------------------------------------------------------------ hotel */

/**
 * Returns a price *index*: what a fixed basket of central properties costs
 * relative to the baseline, not a rate anyone can book.
 *
 * The basket is deterministic per city and the variation is driven by season and
 * by the city's own holiday calendar, which is what actually moves hotel prices
 * in this region (Golden Week, Songkran, Lunar New Year).
 */
export async function fetchHotelIndex(
  destination: City,
  departDate: string,
  holidays: Holiday[],
): Promise<HotelQuote> {
  await latency();

  // Baseline is expressed in the destination's own currency, converted from the
  // CNY anchor, so the index is a pure ratio and currency never leaks in.
  const fxRef = FX_VS_CNY[destination.currency];
  const cnyToLocal = fxRef ? fxRef.cnyToQuote : 1;
  const baselineLocal = 500 * cnyToLocal;

  const rng = rngFor("hotel", destination.id, departDate);
  const month = CLIMATE[destination.id]?.months[monthIndex(departDate)];

  // Seasonal demand: warmer, drier months cost more in this region.
  const seasonal = month
    ? 1 + (month.tempC - 24) * 0.012 - (month.humidityPct - 72) * 0.004
    : 1;

  // Holiday proximity is the dominant driver; count peak days in a +/- 3 window.
  const windowStart = addDays(departDate, -3);
  const windowEnd = addDays(departDate, 3);
  const peakNearby = holidays.filter(
    (h) =>
      h.country === destination.country &&
      h.date >= windowStart &&
      h.date <= windowEnd &&
      (h.weight === "peak" || h.weight === "normal"),
  ).length;
  const holidayLift = 1 + Math.min(peakNearby, 5) * 0.11;

  /**
   * City-level price level is seeded by city alone, not by date. Seeding it per
   * date made it independent noise that could swamp the holiday lift entirely:
   * a ±90% random spread layered on a 44% holiday effect made the model's own
   * holiday behaviour unobservable. Structural differences between cities are a
   * property of the city, not of the query.
   */
  const cityLevel = 0.75 + rngFor("hotel-level", destination.id)() * 0.9;

  // Small per-date variation, so consecutive dates are not identical.
  const dayNoise = between(rng, 0.97, 1.03);

  const index = Math.max(
    0.55,
    seasonal * holidayLift * cityLevel * dayNoise,
  );

  const round3 = (value: number) => Math.round(value * 1000) / 1000;

  return {
    perNightLocal: Math.round(baselineLocal * index),
    baselineLocal: Math.round(baselineLocal),
    confidence: 0.72,
    basis: "hotel-price-index",
    sampleSize: MOCK_SETTINGS.hotelSampleSize,
    components: {
      holidayLift: round3(holidayLift),
      seasonal: round3(seasonal),
      cityLevel: round3(cityLevel),
      nearbyHolidayDays: Math.min(peakNearby, 5),
    },
  };
}

/* ---------------------------------------------------------------- flights */

function fareForDate(
  routeMedianCny: number,
  date: string,
  routeId: string,
): number {
  const rng = rngFor("fare", routeId, date);
  const month = monthIndex(date);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();

  // Seasonality: regional peaks around Lunar New Year, summer and year end.
  const seasonalByMonth = [
    1.18, 1.26, 1.02, 0.98, 1.0, 1.08, 1.22, 1.2, 1.0, 1.02, 0.96, 1.16,
  ];
  const seasonal = seasonalByMonth[month] ?? 1;

  // Weekend departures cost more on leisure routes.
  const weekend = dow === 5 || dow === 6 ? 1.12 : dow === 0 ? 1.06 : 1;

  // Booking curve: very close-in and very far-out fares are both pricier.
  const daysOut = diffDays(
    new Date().toISOString().slice(0, 10),
    date,
  );
  const curve = daysOut < 7 ? 1.22 : daysOut < 21 ? 1.05 : 1;

  const noise = between(rng, 0.88, 1.14);

  return Math.round(
    routeMedianCny * seasonal * weekend * curve * noise,
  );
}

/**
 * Builds the lookback distribution and the percentile of the requested date
 * within it. Sampling is deterministic in (route, date), so the same query
 * always yields the same percentile.
 */
function buildHistory(
  routeMedianCny: number,
  routeId: string,
  departDate: string,
  today: string,
): { min: number; max: number; median: number; percentile: number } {
  const samples: number[] = [];
  for (let i = -MOCK_SETTINGS.fareLookbackDays; i <= 0; i += 1) {
    const d = addDays(today, i);
    samples.push(fareForDate(routeMedianCny, d, routeId));
  }
  samples.sort((a, b) => a - b);

  const min = samples[0];
  const max = samples[samples.length - 1];
  const median = samples[Math.floor(samples.length / 2)];

  const fare = fareForDate(routeMedianCny, departDate, routeId);
  const below = samples.filter((s) => s < fare).length;
  const percentile = Math.round((below / samples.length) * 100);

  return { min, max, median, percentile };
}

export async function fetchFlightQuote(
  origin: City,
  destination: City,
  departDate: string,
  returnDate: string,
  now: Date = new Date(),
): Promise<FlightQuote | FlightUnavailableReason> {
  await latency();

  const today = todayForTrip(origin.timezone, destination.timezone, now);

  // Airlines have not opened the booking window this far out. The spec's hard
  // requirement: report this explicitly, never score it as zero.
  const daysOut = diffDays(today, departDate);
  if (daysOut > MOCK_SETTINGS.bookingWindowDays) {
    return "outside-booking-window";
  }
  if (daysOut < 0) {
    return "no-quote";
  }

  const route = findRoute(origin.id, destination.id);
  if (!route) {
    return "no-quote";
  }

  const history = buildHistory(
    route.medianFareCny,
    route.id,
    departDate,
    today,
  );

  // Attribute the quote to the busier of the two travel days, which is how a
  // round-trip search actually prices.
  const outbound = fareForDate(route.medianFareCny, departDate, route.id);
  const inbound = fareForDate(route.medianFareCny, returnDate, route.id);
  const fareCny = Math.round((outbound + inbound) / 2);

  // Cached fares are aged deterministically by date, so the UI's freshness
  // badge has something real to display.
  const ageRng = rngFor("age", route.id, departDate);
  const ageHours = Math.round(ageRng() * 20 * 10) / 10;
  const fetchedAt = new Date(now.getTime() - ageHours * 3_600_000).toISOString();

  const theoreticalUsd = (route.roundTripMiles * 0.1);

  return {
    basis: "cached-fare",
    fareLocal: fareCny,
    history: {
      lookbackDays: MOCK_SETTINGS.fareLookbackDays,
      min: history.min,
      max: history.max,
      median: history.median,
      percentile: history.percentile,
    },
    fetchedAt,
    confidence: 0.7,
    distanceModel: {
      roundTripMiles: route.roundTripMiles,
      dollarsPerMile: 0.1,
      theoreticalUsd: Math.round(theoreticalUsd * 10) / 10,
    },
  };
}

/**
 * Adapts the provider's return shape to the tagged union the scorers expect.
 * For a booking-window miss it also derives the date bookings open, which is the
 * actionable part of that message ("try again on X").
 */
export function toFlightScorerInput(
  value: FlightQuote | FlightUnavailableReason,
  departDate: string,
): FlightScorerInput {
  if (typeof value !== "string") {
    return { kind: "quote", quote: value };
  }
  if (value === "outside-booking-window") {
    return {
      kind: "unavailable",
      reason: value,
      bookingOpensOn: addDays(departDate, -MOCK_SETTINGS.bookingWindowDays),
    };
  }
  return { kind: "unavailable", reason: value };
}

/* --------------------------------------------------------------- holidays */

export async function fetchHolidays(
  country: string,
  from: string,
  to: string,
): Promise<{ holidays: Holiday[]; coverageComplete: boolean }> {
  await latency();
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  let coverageComplete = true;
  for (let y = fromYear; y <= toYear; y += 1) {
    if (!hasHolidayCoverage(y)) coverageComplete = false;
  }
  return { holidays: holidaysInRange(country, from, to), coverageComplete };
}

/* --------------------------------------------------------------------- fx */

const wo = (currency: string, date: string): number => {
  const ref = FX_VS_CNY[currency];
  if (!ref) return 1;
  // A slow deterministic drift around the reference level.
  const rng = rngFor("fx", currency, date.slice(0, 7));
  const base = between(rng, 0.9, 1.04);
  // Nudge towards a realistic position inside the recorded year range.
  const target = ref.yearLow + (ref.yearHigh - ref.yearLow) * 0.72;
  return (base * ref.cnyToQuote + target) / (2 * ref.cnyToQuote);
};

export async function fetchFx(
  origin: City,
  destination: City,
  asOf: string,
): Promise<FxSnapshot | null> {
  await latency();
  if (origin.currency === destination.currency) return null;

  const { rate, yearLow, yearHigh } = fxRateFor(
    destination.currency,
    asOf,
    wo,
  );

  return {
    // Rate is expressed as: units of destination currency per 1 unit of origin.
    from: origin.currency,
    to: destination.currency,
    rate: Math.round(rate * 10000) / 10000,
    yearLow: Math.round(yearLow * 10000) / 10000,
    yearHigh: Math.round(yearHigh * 10000) / 10000,
    asOf: new Date(`${asOf}T00:00:00Z`).toISOString(),
  };
}

/* ------------------------------------------------------- convenience bundle */


/** Builds everything `scoreTrip` needs, in parallel. */
export async function buildScoreContext(
  trip: TripInput,
  now: Date = new Date(),
): Promise<ScoreContext> {
  const [weather, { holidays }, flight, fx] = await Promise.all([
    fetchWeather(trip.destination, trip.departDate, now),
    fetchHolidays(trip.destination.country, trip.departDate, trip.returnDate),
    fetchFlightQuote(
      trip.origin,
      trip.destination,
      trip.departDate,
      trip.returnDate,
      now,
    ),
    fetchFx(trip.origin, trip.destination, trip.departDate),
  ]);

  const hotel = await fetchHotelIndex(trip.destination, trip.departDate, holidays);

  return {
    weather,
    hotel,
    flight: toFlightScorerInput(flight, trip.departDate),
    holidays,
    fx,
    computedAt: now.toISOString(),
  };
}
