/**
 * Provider composition and context assembly.
 *
 * Two responsibilities:
 *
 *  1. Choose, per dimension, whether to use a live source or the mock one. Sources
 *     are composed individually because their readiness differs: weather, holidays
 *     and FX need no credentials, while flight pricing needs a key and hotel
 *     pricing needs a collection run.
 *
 *  2. Assemble a `ScoreContext` from whichever providers were chosen, alongside a
 *     provenance record. Provenance is returned rather than inferred so the UI can
 *     state plainly where each number came from — a partially-live deployment must
 *     not look fully live, and a fallback must not look like a live quote.
 *
 * ## Where hotel prices come from
 *
 * A hotel chain's own site cannot answer "the median cost of a night in this city" —
 * its portfolio is not a city. Prices come from an inventory aggregator (Hotelbeds),
 * written into a dataset and read through a file-backed store here.
 *
 * That dataset used to be filled only by an offline job. It is now filled on demand as
 * well: with credentials configured, a request for a city that has no fresh prices
 * collects them itself, within a daily request budget (`./collect/on-demand.ts`). The
 * offline CLI still exists for bulk work and backfill, and both write through the same
 * merge so neither can erase the other's cities.
 */

import type { ScoreContext, TripInput } from "../scoring/types";
import {
  getDataSources,
  getFlightCredentials,
  getHotelDatasetPath,
  getHotelSource,
  getHotelbedsCredentials,
  getOnDemandCollection,
} from "./config";
import type { PricingCredentials } from "./config";
import { createMockProvider } from "./mock-provider";
import { createLiveProvider } from "./live";
import { fetchIgnavFlightQuote } from "./live/flights";
import { fetchSelfCollectedHotelPrice } from "./hotel-price";
import { createFileStore } from "./hotel-dataset-file";
import { createHotelbedsAdapter } from "./collect/adapters/hotelbeds";
import { collectCityOnDemand } from "./collect/on-demand";
import type { HotelDataset } from "./hotel-dataset";
import type { City } from "../scoring/types";
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
    fetchHotelPrice() {
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
 * The collected hotel reference price, read from a JSON dataset.
 *
 * This provider owns the read side and the decision to collect: when a city has no
 * fresh prices and credentials exist, `collectCityOnDemand` fills them in before the
 * quote is computed. The collection itself lives in `./collect/`, so the rules that
 * make it safe — budget, freshness, failure isolation — sit in one place rather than
 * being re-derived here.
 */
function createSelfCollectedHotelProvider(datasetPath: string): DataProvider {
  const store = createFileStore(datasetPath);

  /**
   * The on-demand collector, or `undefined` when it is off or unconfigured.
   *
   * Built lazily and only when credentials exist: without a key there is nothing to
   * call, and constructing the adapter anyway would put a guaranteed-failing source on
   * every request path.
   */
  const onDemand = getOnDemandCollection();
  const credentials = getHotelbedsCredentials();
  const collector =
    onDemand.enabled && credentials
      ? (city: City, date: string, dataset: HotelDataset, now: Date) =>
          collectCityOnDemand(city, date, dataset, {
            datasetPath,
            adapter: createHotelbedsAdapter(credentials),
            dailyQuota: onDemand.dailyQuota,
            freshHours: onDemand.freshHours,
            now,
            log: (line) => console.log(`[iittg] ${line}`),
          })
      : undefined;

  return {
    name: "hotelbeds-collected-median",
    fetchWeather() {
      throw new Error("The hotel dataset does not provide weather");
    },
    fetchHolidays() {
      throw new Error("The hotel dataset does not provide holidays");
    },
    fetchFx() {
      throw new Error("The hotel dataset does not provide exchange rates");
    },
    fetchFlightQuote() {
      throw new Error("The hotel dataset does not provide flight pricing");
    },
    fetchHotelPrice(destination, departDate, holidays, now = new Date()) {
      return fetchSelfCollectedHotelPrice(
        destination,
        departDate,
        holidays,
        store,
        now,
        collector,
      );
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
    hotel: mock.fetchHotelPrice.bind(mock),
  });

  const flightCredentials = getFlightCredentials();
  const useLiveFlight = sources.flight === "live" && flightCredentials !== null;
  const flight = useLiveFlight ? createIgnavProvider(flightCredentials) : mock;

  const useSelfCollectedHotel = getHotelSource() === "self-collected";
  const hotel = useSelfCollectedHotel
    ? createSelfCollectedHotelProvider(getHotelDatasetPath())
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
      hotel: useSelfCollectedHotel ? "collected-hotelbeds" : "mock",
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

  const hotel = await providers.hotel.fetchHotelPrice(
    trip.destination,
    trip.departDate,
    holidayResult.holidays,
    now,
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
