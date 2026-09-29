/**
 * Provider composition and context assembly.
 *
 * Two responsibilities:
 *
 *  1. Choose, per dimension, whether to use a live source or the mock one. Sources
 *     are composed individually because their readiness differs: weather, holidays
 *     and FX need no credentials, while flight pricing needs a key.
 *
 *  2. Assemble a `ScoreContext` from whichever providers were chosen, alongside a
 *     provenance record. Provenance is returned rather than inferred so the UI can
 *     state plainly where each number came from — a partially-live deployment must
 *     not look fully live, and a fallback must not look like a live quote.
 *
 * ## Why hotel pricing has no external provider
 *
 * There is no self-serve API for "the average nightly rate of central hotels". The
 * OTA APIs are partnership-gated, and their terms forbid redistributing prices
 * anyway. Hotels are therefore served as an index built from samples this app
 * collects itself; while no samples exist, the mock index stands in and the UI says
 * so. That is a deliberate design position, not an unfinished integration.
 */

import type { ScoreContext, TripInput } from "../scoring/types";
import { getDataSources, getFlightCredentials, getHotelSource } from "./config";
import type { PricingCredentials } from "./config";
import { createMockProvider } from "./mock-provider";
import { createLiveProvider } from "./live";
import { fetchIgnavFlightQuote } from "./live/flights";
import { fetchSelfCollectedHotelIndex } from "./hotel-index";
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
 * Flight pricing through Ignav.
 *
 * A thin `DataProvider` wrapper so the provider contract does not leak the fact that
 * flight pricing is a different class of source (keyed, paid, per-route) from the
 * credential-free ones.
 */
function createIgnavProvider(credentials: PricingCredentials): DataProvider {
  return {
    name: "ignav",
    fetchWeather() {
      throw new Error("Ignav does not provide weather");
    },
    fetchHolidays() {
      throw new Error("Ignav does not provide holidays");
    },
    fetchFx() {
      throw new Error("Ignav does not provide exchange rates");
    },
    fetchHotelIndex() {
      throw new Error("Ignav does not provide hotel pricing");
    },
    fetchFlightQuote(origin, destination, departDate, returnDate) {
      return fetchIgnavFlightQuote(
        credentials,
        origin,
        destination,
        departDate,
        returnDate,
      );
    },
  };
}

/**
 * Hotel index over locally collected price samples.
 *
 * Only the reading side lives here. Collecting the samples is a separate, offline
 * job: it must not run on a request path, and keeping it out of this module is what
 * makes that structurally true rather than merely intended.
 */
function createSelfCollectedHotelProvider(): DataProvider {
  return {
    name: "self-collected-hotel-index",
    fetchWeather() {
      throw new Error("The hotel index does not provide weather");
    },
    fetchHolidays() {
      throw new Error("The hotel index does not provide holidays");
    },
    fetchFx() {
      throw new Error("The hotel index does not provide exchange rates");
    },
    fetchFlightQuote() {
      throw new Error("The hotel index does not provide flight pricing");
    },
    fetchHotelIndex(destination, departDate, holidays) {
      return fetchSelfCollectedHotelIndex(destination, departDate, holidays);
    },
  };
}

/**
 * Builds the provider set for one request.
 *
 * The mock provider is constructed once and shared, so any dimension falling back to
 * it gets the same deterministic series rather than a fresh instance.
 */
export function resolveProviders(): ResolvedProviders {
  const sources = getDataSources();
  const mock = createMockProvider();

  const live = createLiveProvider({
    // Weather, holidays and FX are genuinely live; the two pricing paths are passed
    // through to whichever implementation was selected below.
    flight: mock.fetchFlightQuote.bind(mock),
    hotel: mock.fetchHotelIndex.bind(mock),
  });

  const flightCredentials = getFlightCredentials();
  const useLiveFlight = sources.flight === "live" && flightCredentials !== null;
  const flight = useLiveFlight ? createIgnavProvider(flightCredentials) : mock;

  const useSelfCollectedHotel = getHotelSource() === "self-collected";
  const hotel = useSelfCollectedHotel
    ? createSelfCollectedHotelProvider()
    : mock;

  return {
    weather: sources.weather === "live" ? live : mock,
    holidays: sources.holidays === "live" ? live : mock,
    fx: sources.fx === "live" ? live : mock,
    flight,
    hotel,
    provenance: {
      weather: sources.weather === "live" ? "live-open-meteo" : "mock",
      holidays: sources.holidays === "live" ? "live-nager-date" : "mock",
      fx: sources.fx === "live" ? "live-ecb" : "mock",
      flight: useLiveFlight ? "live-ignav" : "mock",
      hotel: useSelfCollectedHotel ? "self-collected-index" : "mock",
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
 * fetched afterwards because its holiday component is derived from the holiday list,
 * and the collected-sample index needs the same calendar to flag peak dates. That
 * ordering is a real dependency, not an oversight.
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
      // A rate can be live at the provider level but served from the static table for
      // a pair the ECB does not publish, so the finer-grained source wins.
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
