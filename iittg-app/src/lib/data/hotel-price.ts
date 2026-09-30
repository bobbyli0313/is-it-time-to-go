/**
 * Hotel reference price, read side.
 *
 * ## What this number is
 *
 * **The median nightly rate across a city's hotels, as collected by this app**,
 * compared against the brief's ¥500 anchor. Not a booking quote, not a
 * third-party feed, and not an average: the median is taken over *properties*,
 * one vote each, so the figure describes a typical hotel rather than a typical
 * sample.
 *
 * ## Why there is no API integration here
 *
 * A single hotel chain cannot answer "what does a night in this city cost" — its
 * portfolio is not a city. Prices come from an inventory aggregator (Hotelbeds),
 * collected offline by `./collect/` and read here. Collection never runs on a request
 * path: the app must not depend on a live call to render a score.
 *
 * ## The rules that keep the median honest
 *
 *  - **Unavailable beats invented.** A city with too few priced properties
 *    reports a zero-confidence quote, which the scorer turns into an excluded
 *    dimension. Publishing a median over three hotels would look like knowledge
 *    and be noise.
 *  - **Coverage is disclosed.** The quote carries how many of the city's known
 *    properties are behind it, because "median of all hotels" over 9 of 371
 *    hotels is a different claim from the same median over 300.
 *  - **Age is disclosed.** Chain rates are collected, not streamed; a quote
 *    resting on samples older than `STALE_AFTER_DAYS` is flagged and loses
 *    confidence rather than silently passing as current.
 *  - **Never "high" confidence.** Even a fully covered city is a sample of one
 *    room type on one night per property; the badge must not imply a survey.
 */

import type { City, Holiday, HotelQuote } from "../scoring/types";
import { addDays, diffDays, todayIn } from "../scoring/dates";
import { TTL, remember } from "./cache";
import { PARAMS } from "../scoring/dimensions";
import type { OnDemandOutcome } from "./collect/on-demand";
import {
  median,
  quantile,
  reduceToPropertyMedians,
  type CityHotelCensus,
  type HotelDataset,
  type HotelDatasetStore,
  type HotelDisclosure,
  type HotelPriceSample,
} from "./hotel-dataset";

/**
 * How near a sample must be to the requested date to count.
 *
 * A collector cannot price every property on every night, so an exact-date match
 * would almost never hit. Three days either side is close enough that the rate is
 * the same rate in most cities, and it is disclosed as `windowStart`/`windowEnd`
 * rather than left implicit.
 */
export const REFERENCE_WINDOW_DAYS = 3;

/**
 * Minimum priced properties before a city publishes a median at all.
 *
 * Eight rather than the old basket's three: a median over a handful of hotels is
 * dominated by which hotels happened to be sampled, and the whole point of this
 * version is that the number stands for a city. Below this, the hotel dimension is
 * excluded — the same treatment a missing fare gets, because a missing price is
 * not a cheap one.
 */
export const MIN_PROPERTIES = 8;

/** Samples older than this make the quote stale: confidence drops, UI discloses. */
export const STALE_AFTER_DAYS = 45;

/**
 * Ceiling on confidence. Below the scorer's 0.66 "high" threshold on purpose:
 * this is collected aggregator data, never a survey, and the badge has to say so.
 */
export const MAX_CONFIDENCE = 0.62;

export interface ReferencePriceDetail {
  /** Properties behind the median. */
  propertyCount: number;
  /** Properties in the city's census, priced or not. */
  cityPropertyCount: number;
  /**
   * `propertyCount / cityPropertyCount` when the census is complete, else `null`.
   * An incomplete census has no denominator, and reporting 100% would claim the
   * median saw a whole city it never enumerated.
   */
  coverage: number | null;
  /** Whether the city's property list is known to be exhaustive. */
  censusComplete: boolean;
  windowStart: string;
  windowEnd: string;
  medianLocal: number;
  p25Local: number;
  p75Local: number;
  /** Interquartile range as a fraction of the median — the spread disclosure. */
  spreadRatio: number;
  /** Newest `collectedAt` among the samples used. */
  newestSampleAt: string;
  /** Age of the newest sample in days, at the moment of scoring. */
  ageDays: number;
  /** True when the newest sample is older than `STALE_AFTER_DAYS`. */
  stale: boolean;
  /** Distinct collectors behind the samples, for mixed-source disclosure. */
  sources: string[];
  /** Properties whose median rests on inferred extractions only. */
  inferredProperties: number;
}

export interface ReferencePriceComputation {
  quote: HotelQuote;
  detail: ReferencePriceDetail | null;
}

/** The quote a city with no usable data produces: zero confidence, no price. */
export function unavailableQuote(
  baselineLocal: number,
  disclosure: HotelDisclosure = "price",
): HotelQuote {
  return {
    perNightLocal: 0,
    baselineLocal,
    confidence: 0,
    basis: "collected-median",
    sampleSize: 0,
    disclosure,
  };
}

/**
 * Computes a city's reference price for a date.
 *
 * Pure and total: it either returns a median with its disclosure, or an
 * unavailable quote and a `null` detail. It never throws and never invents.
 */
export function computeCityReferencePrice(
  census: CityHotelCensus,
  samples: HotelPriceSample[],
  departDate: string,
  now: Date = new Date(),
  disclosure: HotelDisclosure = "price",
): ReferencePriceComputation {
  const windowStart = addDays(departDate, -REFERENCE_WINDOW_DAYS);
  const windowEnd = addDays(departDate, REFERENCE_WINDOW_DAYS);

  /**
   * Only samples for properties in this city's census count. A property id that
   * is not in the census is either a typo or a sample from another city, and
   * either way attributing it here would corrupt the median.
   */
  const censusIds = new Set(census.properties.map((p) => p.id));
  const inWindow = samples.filter(
    (sample) =>
      sample.date >= windowStart &&
      sample.date <= windowEnd &&
      censusIds.has(sample.propertyId),
  );

  const propertyMedians = reduceToPropertyMedians(inWindow);

  if (propertyMedians.length < MIN_PROPERTIES) {
    return { quote: unavailableQuote(census.baselineLocal, disclosure), detail: null };
  }

  const perProperty = propertyMedians.map((p) => p.medianLocal);
  const medianLocal = Math.round(median(perProperty));
  const p25Local = Math.round(quantile(perProperty, 0.25));
  const p75Local = Math.round(quantile(perProperty, 0.75));

  const propertyCount = propertyMedians.length;
  const cityPropertyCount = census.properties.length;
  const censusComplete = census.censusComplete === true;
  const coverage =
    censusComplete && cityPropertyCount > 0 ? propertyCount / cityPropertyCount : null;

  const spreadRatio = medianLocal > 0 ? (p75Local - p25Local) / medianLocal : 1;

  const newestSampleAt = propertyMedians.reduce(
    (latest, p) => (p.newestCollectedAt > latest ? p.newestCollectedAt : latest),
    propertyMedians[0].newestCollectedAt,
  );
  /**
   * Age is measured against *now*, not against the trip date. Data collected last
   * week is fresh whether the trip is next month or next year; comparing the
   * collection date with the departure date would instead mark every far-future
   * trip as stale, which is a different (and false) claim.
   */
  const ageDays = Math.max(
    0,
    diffDays(newestSampleAt.slice(0, 10), todayIn("UTC", now)),
  );
  const stale = ageDays > STALE_AFTER_DAYS;

  const inferredProperties = propertyMedians.filter((p) => p.inferredOnly).length;
  const sources = [
    ...new Set(inWindow.map((sample) => sample.source)),
  ].sort();

  /**
   * Confidence, built from breadth of coverage and reduced by everything the
   * number cannot speak to: dispersion across hotels, properties the census knows
   * about but we have no price for, inferred extractions, and age.
   */
  const breadth = Math.min(
    1,
    propertyCount / (PARAMS.hotel.minSampleForHighConfidence * 2),
  );
  const spreadPenalty = Math.min(0.3, spreadRatio / 2);
  // An unknown denominator is not penalised — there is nothing to compare
  // against — but it is also never reported as full coverage.
  const coveragePenalty = coverage === null ? 0 : 0.2 * (1 - Math.min(1, coverage));
  const inferredPenalty = 0.15 * (inferredProperties / propertyCount);
  const stalePenalty = stale ? 0.15 : 0;
  const confidence = Math.max(
    0.25,
    Math.min(
      MAX_CONFIDENCE,
      0.4 +
        breadth * 0.35 -
        spreadPenalty -
        coveragePenalty -
        inferredPenalty -
        stalePenalty,
    ),
  );

  return {
    quote: {
      perNightLocal: medianLocal,
      baselineLocal: census.baselineLocal,
      confidence: Math.round(confidence * 1000) / 1000,
      basis: "collected-median",
      sampleSize: propertyCount,
      /**
       * Only claimed when the census really enumerates a universe. With a partial
       * census the denominator is unknown, and "12 of 12 known" would read as full
       * coverage of something never enumerated.
       */
      ...(censusComplete ? { propertyUniverse: cityPropertyCount } : {}),
      disclosure,
      collectedAt: newestSampleAt,
      stale,
    },
    detail: {
      propertyCount,
      cityPropertyCount,
      coverage,
      censusComplete,
      windowStart,
      windowEnd,
      medianLocal,
      p25Local,
      p75Local,
      spreadRatio,
      newestSampleAt,
      ageDays,
      stale,
      sources,
      inferredProperties,
    },
  };
}

/* ------------------------------------------------------------------ loading */

/** Default store: an empty dataset. Replaced by the file store in composition. */
export const EMPTY_STORE: HotelDatasetStore = {
  async load() {
    return {
      version: 2,
      basis: { adults: 2, rooms: 1, roomClass: "cheapest-available", taxIncluded: true },
      cities: [],
      samples: [],
    };
  },
};

/**
 * Collects this city-night on the request path, if the operator has enabled it.
 *
 * Injectable so the read side does not import the collector, the transport or Hotelbeds
 * credentials: a store plus this hook is all it takes to test the fallback, and a
 * deployment without the hook behaves exactly as it did before on-demand collection
 * existed.
 */
export type OnDemandCollector = (
  city: City,
  date: string,
  dataset: HotelDataset,
  now: Date,
) => Promise<{ dataset: HotelDataset; outcome: OnDemandOutcome }>;

/**
 * Resolves the reference price for a city and date.
 *
 * Returns a zero-confidence quote when unavailable, which the scorer turns into
 * an excluded dimension — a missing hotel estimate must never be scored as a
 * cheap one.
 *
 * With `collect` supplied, a city that has no usable samples is collected first. That
 * reverses the original design, where collection was strictly offline — see
 * `collect/on-demand.ts` for why, and for what stops it from spending the day's quota
 * or failing a score.
 */
export async function fetchSelfCollectedHotelPrice(
  destination: City,
  departDate: string,
  _holidays: Holiday[],
  store: HotelDatasetStore = EMPTY_STORE,
  now: Date = new Date(),
  collect?: OnDemandCollector,
): Promise<HotelQuote> {
  /**
   * The dataset is loaded *before* the cache is consulted, because its identity is
   * part of the cache key.
   *
   * This was a real bug: with the key on `(city, date)` alone, a collection run
   * wrote a new dataset and the app kept serving the previous run's median until the
   * TTL expired — a fresh collection silently invisible for hours. The store caches
   * by mtime, so this costs a `stat` and nothing else.
   */
  let dataset = await store.load();

  /**
   * Collect before caching, and only when there is something to collect.
   *
   * `collect` decides for itself whether the city is fresh, whether the day's budget
   * allows it, and what to do about failures — this call cannot throw, and its result
   * carries a reason that is surfaced to the user rather than swallowed.
   */
  let collection: OnDemandOutcome | null = null;
  if (collect) {
    const result = await collect(destination, departDate, dataset, now);
    dataset = result.dataset;
    collection = result.outcome;
  }

  const version = dataset.generatedAt ?? "unversioned";
  const disclosure = dataset.disclosure ?? "price";
  const key = `hotel-price:${destination.id}:${departDate}:${version}:${disclosure}`;

  const quote = await remember(
    key,
    async () => {
      const census = dataset.cities.find((c) => c.cityId === destination.id);

      if (!census) {
        // No census for this city yet: unavailable, not zero.
        return unavailableQuote(0);
      }

      const { quote: computed } = computeCityReferencePrice(
        census,
        dataset.samples,
        departDate,
        now,
        disclosure,
      );
      return computed;
    },
    // Long TTL: collected samples change daily at most, and the reference price
    // is deliberately a slow-moving level rather than a live quote. A new dataset
    // gets a new key, so a collection run takes effect immediately.
    { ttlMs: TTL.hotelIndex, staleOnError: true },
  );

  /**
   * The collection outcome travels with the quote so the response can say *why* a city
   * has no price — never collected, out of budget, or the source refused — instead of
   * leaving the user to guess. It is not part of the cached value: the cache holds the
   * price, and this is a fact about the request that produced it.
   */
  return collection && collection.status !== "fresh"
    ? { ...quote, collection }
    : { ...quote, ...(collection ? { collection } : {}) };
}

/** Exposed for tests and for the CLI's report, which states the same rules. */
export const internals = {
  REFERENCE_WINDOW_DAYS,
  MIN_PROPERTIES,
  STALE_AFTER_DAYS,
  MAX_CONFIDENCE,
};

/** Re-exported so callers do not need to reach into the dataset module. */
export type { HotelDataset, HotelDatasetStore, CityHotelCensus };
