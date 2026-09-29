/**
 * The data provider contract.
 *
 * Both the mock and the live implementations satisfy this interface, and the
 * factory in `index.ts` composes them per dimension. That per-dimension split is
 * what lets weather, holidays and FX run live while flight and hotel pricing stay
 * on mock data until credentials exist — a single all-or-nothing switch would block
 * the three working sources behind the two that are not ready.
 *
 * Implementations must uphold the provenance rules the model depends on:
 *  - never present a climate normal as a forecast,
 *  - never present a cached fare as a live quote,
 *  - never present a collected median as a bookable rate, and never present
 *    synthetic data as collected.
 */

import type {
  City,
  FlightScorerInput,
  Holiday,
  HotelQuote,
  TripInput,
  WeatherSample,
} from "../scoring/types";
import type { FxResult } from "./live/fx";

export interface HolidayResult {
  holidays: Holiday[];
  /**
   * False when a year in the range had no data at all, which is indistinguishable
   * from "no holidays" without this flag. The caller discloses the gap so a
   * coverage hole cannot silently read as zero crowding.
   */
  coverageComplete: boolean;
}

export interface DataProvider {
  readonly name: string;

  fetchWeather(destination: City, date: string, now?: Date): Promise<WeatherSample>;

  /**
   * The city's reference nightly rate: the median across its collected hotels.
   * Returns a zero-confidence quote when no city data exists, which the scorer
   * turns into an excluded dimension rather than a cheap one.
   */
  fetchHotelPrice(
    destination: City,
    departDate: string,
    holidays: Holiday[],
    now?: Date,
  ): Promise<HotelQuote>;

  fetchFlightQuote(
    origin: City,
    destination: City,
    departDate: string,
    returnDate: string,
    now?: Date,
  ): Promise<FlightScorerInput>;

  fetchHolidays(
    country: string,
    from: string,
    to: string,
  ): Promise<HolidayResult>;

  /** `null` means same-currency, which is "not applicable" rather than a failure. */
  fetchFx(origin: City, destination: City, now?: Date): Promise<FxResult | null>;
}

/** Per-dimension provenance, so the UI can state where each number came from. */
export interface DataProvenance {
  weather: "live-open-meteo" | "mock";
  /** Feeds the crowding dimension rather than a dimension of its own. */
  holidays: "live-nager-date" | "mock";
  fx: "live-ecb" | "static-reference" | "mock" | "not-applicable";
  flight: "live-ignav" | "mock";
  /**
   * Hotels are a median over rates this app collected from Hotelbeds, and the label
   * names the source because that is what a reader needs to judge the number.
   * Deliberately distinct from `mock`, so a deployment that has never run the
   * collector cannot look live.
   */
  hotel: "collected-hotelbeds" | "mock";
}

export interface BuiltContext {
  context: import("../scoring/types").ScoreContext;
  provenance: DataProvenance;
}

/** Convenience alias so implementations can share the trip shape. */
export type TripLike = Pick<
  TripInput,
  "origin" | "destination" | "departDate" | "returnDate"
>;
