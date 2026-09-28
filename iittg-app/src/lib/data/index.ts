/**
 * Provider composition and context assembly.
 *
 * Two responsibilities:
 *
 *  1. Choose, per dimension, whether to use the live source or the mock one.
 *     Sources are composed individually because their readiness differs: weather,
 *     holidays and FX need no credentials, while flight and hotel pricing need
 *     Amadeus keys that may not exist yet.
 *
 *  2. Assemble a `ScoreContext` from whichever providers were chosen, alongside a
 *     provenance record. Provenance is returned rather than inferred so the UI can
 *     state plainly where each number came from — a partially-live deployment must
 *     not look fully live, and a static fallback must not look like a live quote.
 */

import type { ScoreContext, TripInput } from "../scoring/types";
import { getAmadeusCredentials, getDataSources } from "./config";
import { createMockProvider } from "./mock-provider";
import { createLiveProvider } from "./live";
import { createAmadeusProvider } from "./live/amadeus";
import type { DataProvider, DataProvenance } from "./types";

export interface ResolvedProviders {
  weather: DataProvider;
  holidays: DataProvider;
  fx: DataProvider;
  flight: DataProvider;
  hotel: DataProvider;
  provenance: DataProvenance;
}

/**
 * Builds the provider set for one request.
 *
 * Amadeus is constructed once and shared by the flight and hotel dimensions, since
 * both need the same OAuth token and the client caches it internally.
 */
export function resolveProviders(): ResolvedProviders {
  const sources = getDataSources();
  const mock = createMockProvider();
  const live = createLiveProvider({
    hotel: mock.fetchHotelIndex.bind(mock),
    flight: mock.fetchFlightQuote.bind(mock),
  });

  const credentials = getAmadeusCredentials();
  const amadeus =
    credentials && (sources.flight === "live" || sources.hotel === "live")
      ? createAmadeusProvider(credentials)
      : null;

  const flightSource =
    sources.flight === "live" && amadeus ? amadeus : mock;
  const hotelSource = sources.hotel === "live" && amadeus ? amadeus : mock;

  return {
    weather: sources.weather === "live" ? live : mock,
    holidays: sources.holidays === "live" ? live : mock,
    fx: sources.fx === "live" ? live : mock,
    flight: flightSource,
    hotel: hotelSource,
    provenance: {
      weather: sources.weather === "live" ? "live-open-meteo" : "mock",
      holidays: sources.holidays === "live" ? "live-nager-date" : "mock",
      fx: sources.fx === "live" ? "live-ecb" : "mock",
      flight: flightSource === amadeus ? "live-amadeus" : "mock",
      hotel: hotelSource === amadeus ? "live-amadeus" : "mock",
    },
  };
}

export interface Assembly {
  context: ScoreContext;
  provenance: DataProvenance;
  /**
   * False when the holiday source could not answer for some year in the range.
   * Surfaced so an outage is disclosed as a degraded estimate rather than silently
   * scoring as "no holidays", which would flatter the crowding result.
   */
  holidayCoverageComplete: boolean;
}

/**
 * Builds everything `scoreTrip` needs.
 *
 * Weather, holidays, flight and FX are fetched in parallel; the hotel index is
 * fetched afterwards because the mock implementation derives its holiday component
 * from the holiday list, and the Amadeus implementation will need the same
 * calendar to flag peak dates. That ordering is a real dependency, not an
 * oversight.
 */
export async function buildScoreContext(
  trip: TripInput,
  now: Date = new Date(),
  providers: ResolvedProviders = resolveProviders(),
): Promise<Assembly> {
  const [weather, holidayResult, flight, fxResult] = await Promise.all([
    providers.weather.fetchWeather(trip.destination, trip.departDate, now),
    providers.holidays.fetchHolidays(
      trip.destination.country,
      trip.departDate,
      trip.returnDate,
    ),
    providers.flight.fetchFlightQuote(
      trip.origin,
      trip.destination,
      trip.departDate,
      trip.returnDate,
      now,
    ),
    providers.fx.fetchFx(trip.origin, trip.destination, now),
  ]);

  const hotel = await providers.hotel.fetchHotelIndex(
    trip.destination,
    trip.departDate,
    holidayResult.holidays,
  );

  return {
    holidayCoverageComplete: holidayResult.coverageComplete,
    context: {
      weather,
      hotel,
      flight,
      holidays: holidayResult.holidays,
      fx: fxResult?.snapshot ?? null,
      computedAt: now.toISOString(),
    },
    provenance: {
      ...providers.provenance,
      // A rate can be live at the provider level but served from the static table
      // for a pair the ECB does not publish, so the finer-grained source wins.
      fx: fxResult
        ? fxResult.source === "ecb-daily"
          ? "live-ecb"
          : fxResult.source === "static-reference"
            ? "static-reference"
            : "mock"
        : "not-applicable",
    },
  };
}

export { createMockProvider } from "./mock-provider";
