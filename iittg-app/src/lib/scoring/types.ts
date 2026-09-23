/**
 * Domain model for IITTG.
 *
 * Core design rule: anything whose trustworthiness varies is modelled as a
 * discriminated union that *names* its provenance. This makes it impossible to
 * accidentally treat a 45-day-out climate normal as a real forecast, or a
 * cached fare as a live quote — the compiler refuses to build it.
 */

/* ------------------------------------------------------------------ cities */

export type CountryCode = string; // ISO 3166-1 alpha-2
export type CurrencyCode = string; // ISO 4217
export type IataCode = string;

export interface City {
  /** Stable slug used as the primary key across the data set. */
  id: string;
  /** IATA city code where one exists (TYO, SEL, SHA...), else the main airport code. */
  iataCity: IataCode;
  /** Airports belonging to this city. The first entry is the default origin/destination. */
  airports: IataCode[];
  country: CountryCode;
  currency: CurrencyCode;
  /** IANA timezone, e.g. "Asia/Tokyo". Used for every date calculation. */
  timezone: string;
  /** City-centre coordinates, used to pick the weather grid point. */
  lat: number;
  lon: number;
  name: { en: string; zh: string };
}

/* ------------------------------------------------------------------ routes */

export interface Route {
  id: string;
  originCityId: string;
  destinationCityId: string;
  /** Great-circle distance in statute miles, round trip. */
  roundTripMiles: number;
  /** Which airport pair the mock fares were sampled from. */
  airportPair: [IataCode, IataCode];
}

/* ----------------------------------------------------------------- weather */

export type WeatherBasis = "forecast" | "climate-normal";

export interface WeatherSample {
  date: string; // ISO date
  /** Names its own provenance. Never assume this is a forecast. */
  basis: WeatherBasis;
  /** For `climate-normal` these are historical averages, and the spread below applies. */
  tempC: number;
  humidityPct: number;
  /** Historical p25/p75 for the calendar window; only meaningful for climate normals. */
  tempSpreadC: number;
  humiditySpreadPct: number;
  /** 0-100 chance of rain, present for forecasts only. */
  precipProbabilityPct?: number;
}

/* ------------------------------------------------------------------ hotels */

export type HotelBasis = "hotel-price-index" | "mock-flat";

export interface HotelQuote {
  /** Per-night average in the destination currency. */
  perNightLocal: number;
  /** What the nightly price is being compared against — always explicit. */
  baselineLocal: number;
  /** 0-1 confidence, drives the confidence badge in the UI. */
  confidence: number;
  basis: HotelBasis;
  /** Number of properties behind the number. Shown verbatim in the UI. */
  sampleSize: number;
  /**
   * The index decomposed into its drivers. Kept explicit rather than collapsed
   * into one opaque multiplier so the UI can say *why* a destination is
   * expensive, and so the holiday effect is testable independently of season.
   */
  components?: {
    /** Multiplier from holiday proximity. */
    holidayLift: number;
    /** Multiplier from the month's seasonal demand. */
    seasonal: number;
    /** The city's structural price level. */
    cityLevel: number;
    /** Peak/normal holiday days found inside the +/- 3 day window. */
    nearbyHolidayDays: number;
  };
}

/* ----------------------------------------------------------------- flights */

export type FlightBasis = "cached-fare" | "distance-model" | "blended";

export interface FlightQuote {
  basis: FlightBasis;
  /** Lowest attributable round-trip fare found, in the origin currency. */
  fareLocal: number;
  /**
   * Distribution of round-trip fares observed on this route over the lookback
   * window. Used to score on percentile rather than on distance.
   */
  history?: {
    lookbackDays: number;
    min: number;
    max: number;
    median: number;
    /** Percentile rank (0-100) of `fareLocal` within the history. */
    percentile: number;
  };
  /** ISO timestamp of the cached quote. Rendered as "prices updated Xh ago". */
  fetchedAt: string;
  /** Distance-model fallback inputs, always present so we can show the ratio. */
  distanceModel: {
    roundTripMiles: number;
    dollarsPerMile: number;
    theoreticalUsd: number;
  };
  confidence: number;
}

/**
 * The two ways a flight dimension can arrive. Modelled as a tagged union rather
 * than `FlightQuote | null` so that "we have no fare, and here is exactly why"
 * is distinguishable from "we failed to look". The unavailable branch is
 * excluded from the total instead of being scored as zero — the spec's hard
 * requirement for dates the airline has not put on sale yet.
 */
export type FlightScorerInput =
  | { kind: "quote"; quote: FlightQuote }
  | {
      kind: "unavailable";
      reason: FlightUnavailableReason;
      /** ISO date the booking window opens, when known. */
      bookingOpensOn?: string;
    };

/** Why no fare could be produced for the requested dates. */
export type FlightUnavailableReason =
  | "outside-booking-window"
  | "no-quote";

/* --------------------------------------------------------------- holidays */

export type HolidayWeight = "peak" | "normal" | "minor";

export interface Holiday {
  date: string;
  country: CountryCode;
  name: { en: string; zh: string };
  weight: HolidayWeight;
}

/* --------------------------------------------------------------------- fx */

export interface FxSnapshot {
  from: CurrencyCode;
  to: CurrencyCode;
  /** Units of `to` per 1 unit of `from`. */
  rate: number;
  yearLow: number;
  yearHigh: number;
  asOf: string;
}

/* ------------------------------------------------------- scoring contract */

export type DimensionKey =
  | "weather"
  | "hotel"
  | "flight"
  | "crowd"
  | "fx";

export type Confidence = "high" | "medium" | "low";

export interface DimensionScore {
  key: DimensionKey;
  /** null means "not applicable" — e.g. FX on a same-currency trip. */
  score: number | null;
  applicable: boolean;
  confidence: Confidence;
  weight: number;
  /** Machine-readable chips rendered by the UI, e.g. { basis: "cached-fare" }. */
  facts: Record<string, string | number>;
  /** i18n keys for the "why" bullets. Never hardcode prose in the scorer. */
  drivers: string[];
  /** Free-form, non-localised debug numbers, surfaced in a details panel. */
  debug?: Record<string, number | string | null>;
}

export interface TripInput {
  origin: City;
  destination: City;
  /** Inclusive departure date, ISO. */
  departDate: string;
  /** Inclusive return date, ISO. */
  returnDate: string;
  /** Number of travellers — currently only affects nothing, reserved. */
  travellers?: number;
}

export interface ScoreContext {
  weather: WeatherSample;
  hotel: HotelQuote;
  flight: FlightScorerInput;
  holidays: Holiday[];
  fx: FxSnapshot | null;
  /** ISO timestamp the whole computation ran. */
  computedAt: string;
}

export interface ScoreResult {
  total: number;
  /** Kept alongside so the UI can show how far the geometric mean moved it. */
  arithmeticMean: number;
  /** Set when a single dimension dragged the total down and the cap applied. */
  cappedBy: DimensionKey | null;
  dimensions: DimensionScore[];
  /** The dimensions costing the most points, worst first. Powers attribution UI. */
  attribution: Array<{ key: DimensionKey; pointsLost: number }>;
  /** i18n keys for trip-level caveats (low confidence, missing data, ...). */
  warnings: string[];
  tripDays: number;
}
