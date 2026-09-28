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
 *  - never present a hotel price index as a bookable rate.
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

  fetchHotelIndex(
    destination: City,
    departDate: string,
    holidays: Holiday[],
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
  flight: "live-amadeus" | "mock";
  hotel: "live-amadeus" | "mock";
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
