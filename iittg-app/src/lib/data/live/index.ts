/**
 * Live implementations of the credential-free sources.
 *
 * Weather (Open-Meteo), holidays (Nager.Date) and FX (Frankfurter) all run without
 * keys, so these three are genuinely live. Flight and hotel pricing are not here:
 * flights need a key, and hotel prices come from an offline collection run
 * (`../collect/`). Both are delegated to whichever implementation the composition
 * layer selected, so neither is faked here.
 */

import type {
  City,
  FlightScorerInput,
  FxSnapshot,
  Holiday,
  HotelQuote,
  WeatherSample,
} from "../../scoring/types";
import type { DataProvider, HolidayResult } from "../types";
import { fetchLiveHolidays } from "./holidays";
import { fetchLiveWeather } from "./weather";
import { fetchLiveFx, type FxResult } from "./fx";

/**
 * Adapter that exposes the three live sources through the shared `DataProvider`
 * contract. The two credential-gated methods delegate to the mock implementation
 * supplied by the caller, so a partially-live deployment is expressible without
 * duplicating any logic here.
 */
export function createLiveProvider(delegate: {
  hotel: DataProvider["fetchHotelPrice"];
  flight: DataProvider["fetchFlightQuote"];
}): DataProvider {
  return {
    name: "live",

    fetchWeather(
      destination: City,
      date: string,
      now: Date = new Date(),
    ): Promise<WeatherSample> {
      return fetchLiveWeather(destination, date, now);
    },

    fetchHotelPrice(
      destination: City,
      departDate: string,
      holidays: Holiday[],
      now: Date = new Date(),
    ): Promise<HotelQuote> {
      return delegate.hotel(destination, departDate, holidays, now);
    },

    fetchFlightQuote(
      origin: City,
      destination: City,
      departDate: string,
      returnDate: string,
      now: Date = new Date(),
    ): Promise<FlightScorerInput> {
      return delegate.flight(origin, destination, departDate, returnDate, now);
    },

    fetchHolidays(
      country: string,
      from: string,
      to: string,
    ): Promise<HolidayResult> {
      return fetchLiveHolidays(country, from, to);
    },

    fetchFx(
      origin: City,
      destination: City,
      now: Date = new Date(),
    ): Promise<FxResult | null> {
      return fetchLiveFx(origin, destination, now);
    },
  };
}

export { fetchLiveWeather } from "./weather";
export { fetchLiveHolidays } from "./holidays";
export { fetchLiveFx, type FxResult, type FxSource } from "./fx";
export type { ClimateNormal } from "./weather";

/** Re-exported for callers that only need the snapshot shape. */
export type FxSnapshotResult = { snapshot: FxSnapshot };
