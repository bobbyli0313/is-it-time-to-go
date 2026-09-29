/**
 * Hotel price index, read side.
 *
 * ## What this is, and why it is not an API integration
 *
 * The product needs "how expensive are central hotels in this city right now". No
 * self-serve API provides that. The OTA APIs are partnership-gated, and their terms
 * forbid redistributing nightly rates regardless. So the index is built from price
 * samples this app collects and stores itself.
 *
 * That has three consequences worth stating plainly:
 *
 * 1. **It is a relative index, never a bookable rate.** The UI says so on every card
 *    (`hotel.fact.indexNotBookable`). Publishing "Tokyo is 24% above its baseline" is
 *    original data; publishing "this room costs ¥2,882" would be redistribution.
 * 2. **Coverage is earned, not granted.** A city with no samples reports an
 *    unavailable dimension rather than an invented number.
 * 3. **The basket is fixed per city.** An index is only meaningful if its members do
 *    not change between samples, so the collect side stores a stable property list
 *    per city and refuses to mix baskets.
 *
 * Collection is deliberately *not* in this module. It is an offline job that must
 * never run on a request path, and keeping it elsewhere is what makes that
 * structurally true rather than merely intended.
 *
 * ## Storage
 *
 * A JSON file rather than a database: the sample volume is small (cities × properties
 * × dates), it is human-inspectable, and it can be reviewed in a diff. If the sample
 * volume grows past what a file can hold comfortably, this module is the only thing
 * that needs to change.
 */

import type { City, Holiday, HotelQuote } from "../scoring/types";
import { findCity } from "./cities";
import { addDays, diffDays } from "../scoring/dates";
import { TTL, remember } from "./cache";
import { PARAMS } from "../scoring/dimensions";

/**
 * How near a sample must be to the requested date to count.
 *
 * Samples are sparse (a collector cannot sample every property every day), so an
 * exact-date match would almost never hit. A window makes the index usable while
 * keeping it honest: the disclosed `sampleDateRange` states what was actually used.
 */
const SAMPLE_WINDOW_DAYS = 3;

/** Minimum samples before an index is published at all. */
const MIN_SAMPLES = 3;

export interface HotelPriceSample {
  /** ISO date the sample was taken for. */
  date: string;
  /** Property identifier within the basket. */
  propertyId: string;
  /** Nightly price in the destination's own currency. */
  priceLocal: number;
  /** Where the number came from, so a mixed-source file stays auditable. */
  source: string;
  /** ISO timestamp of collection. */
  collectedAt: string;
}

export interface CityHotelBasket {
  cityId: string;
  currency: string;
  /**
   * The fixed set of properties. Sample sets that do not match this exactly are
   * rejected, because an index whose membership drifts is not comparable over time.
   */
  propertyIds: string[];
  /** Baseline nightly price in the local currency, against which the index is taken. */
  baselineLocal: number;
  /** Notes on how the basket was chosen; surfaced in the data-details panel. */
  notes?: string;
}

export interface HotelIndexDataset {
  /** Dataset version, so a format change is detectable rather than silently misread. */
  version: 1;
  baskets: CityHotelBasket[];
  samples: HotelPriceSample[];
}

export interface HotelIndexStore {
  load(): Promise<HotelIndexDataset>;
}

/* ------------------------------------------------------------- computation */

export interface IndexComputation {
  quote: HotelQuote;
  /** Facts the UI can disclose, or null when no index could be built. */
  detail: {
    sampleCount: number;
    windowStart: string;
    windowEnd: string;
    spread: number;
    medianLocal: number;
  } | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Builds an index from samples, or reports it as unavailable.
 *
 * Median rather than mean: a single boutique suite in the basket would otherwise drag
 * the average by a factor, and the score is meant to reflect a typical stay.
 */
export function computeHotelIndex(
  basket: CityHotelBasket,
  samples: HotelPriceSample[],
  departDate: string,
): IndexComputation {
  const windowStart = addDays(departDate, -SAMPLE_WINDOW_DAYS);
  const windowEnd = addDays(departDate, SAMPLE_WINDOW_DAYS);

  const inWindow = samples.filter(
    (sample) => sample.date >= windowStart && sample.date <= windowEnd,
  );

  /**
   * Only samples from the declared basket count. A price collected for a property
   * outside the basket would silently change what the index measures.
   */
  const basketSet = new Set(basket.propertyIds);
  const usable = inWindow.filter((sample) => basketSet.has(sample.propertyId));

  const unavailable: HotelQuote = {
    perNightLocal: 0,
    baselineLocal: basket.baselineLocal,
    confidence: 0,
    basis: "hotel-price-index",
    sampleSize: 0,
  };

  if (usable.length < MIN_SAMPLES) {
    return { quote: unavailable, detail: null };
  }

  const prices = usable.map((sample) => sample.priceLocal).filter((p) => p > 0);
  if (prices.length < MIN_SAMPLES) {
    return { quote: unavailable, detail: null };
  }

  const medianLocal = Math.round(median(prices));
  const spread =
    prices.length > 1
      ? Math.max(...prices) - Math.min(...prices)
      : 0;

  /**
   * Confidence rises with sample breadth but is capped: even a well-sampled basket is
   * a handful of properties standing in for a whole city, and the UI must not present
   * it as a survey.
   */
  const breadth = Math.min(1, usable.length / (PARAMS.hotel.minSampleForHighConfidence * 2));
  const spreadPenalty = medianLocal > 0 ? Math.min(0.3, spread / medianLocal / 2) : 0.3;

  return {
    quote: {
      perNightLocal: medianLocal,
      baselineLocal: basket.baselineLocal,
      confidence: Math.max(0.3, Math.min(0.75, 0.4 + breadth * 0.35 - spreadPenalty)),
      basis: "hotel-price-index",
      sampleSize: usable.length,
    },
    detail: {
      sampleCount: usable.length,
      windowStart,
      windowEnd,
      spread: Math.round(spread),
      medianLocal,
    },
  };
}

/* ------------------------------------------------------------------ loading */

/** Default store: an empty dataset. Replaced by the file store in the composition layer. */
export const EMPTY_STORE: HotelIndexStore = {
  async load() {
    return { version: 1, baskets: [], samples: [] };
  },
};

/**
 * Resolves the hotel index for a city and date.
 *
 * Returns a zero-confidence quote when unavailable, which the scorer turns into an
 * excluded dimension — a missing hotel estimate must never be scored as a cheap one.
 */
export async function fetchSelfCollectedHotelIndex(
  destination: City,
  departDate: string,
  _holidays: Holiday[],
  store: HotelIndexStore = EMPTY_STORE,
): Promise<HotelQuote> {
  const key = `hotel-index:${destination.id}:${departDate}`;

  return remember(
    key,
    async () => {
      const dataset = await store.load();
      const basket = dataset.baskets.find((b) => b.cityId === destination.id);

      if (!basket) {
        // No basket curated for this city yet: unavailable, not zero.
        return {
          perNightLocal: 0,
          baselineLocal: 0,
          confidence: 0,
          basis: "hotel-price-index" as const,
          sampleSize: 0,
        };
      }

      const { quote } = computeHotelIndex(basket, dataset.samples, departDate);
      return quote;
    },
    // Long TTL: collected samples change daily at most, and the index is deliberately
    // a slow-moving relative measure rather than a live quote.
    { ttlMs: TTL.hotelIndex, staleOnError: true },
  );
}

/** Validates a dataset, so a malformed file fails loudly instead of skewing scores. */
export function validateDataset(value: unknown): { ok: true; data: HotelIndexDataset } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: ["dataset is not an object"] };
  }
  const d = value as Partial<HotelIndexDataset>;
  if (d.version !== 1) errors.push(`unsupported version: ${String(d.version)}`);
  if (!Array.isArray(d.baskets)) errors.push("baskets is not an array");
  if (!Array.isArray(d.samples)) errors.push("samples is not an array");

  for (const [i, basket] of (d.baskets ?? []).entries()) {
    if (!findCity(basket.cityId)) errors.push(`baskets[${i}]: unknown city ${basket.cityId}`);
    if (!Array.isArray(basket.propertyIds) || basket.propertyIds.length === 0) {
      errors.push(`baskets[${i}]: propertyIds is empty`);
    }
    if (!(basket.baselineLocal > 0)) errors.push(`baskets[${i}]: baselineLocal must be positive`);
  }

  for (const [i, sample] of (d.samples ?? []).entries()) {
    if (!Number.isFinite(sample.priceLocal) || sample.priceLocal <= 0) {
      errors.push(`samples[${i}]: priceLocal must be positive`);
    }
    if (diffDays(sample.date, sample.date) !== 0) {
      errors.push(`samples[${i}]: date is not ISO`);
    }
  }

  return errors.length === 0
    ? { ok: true, data: d as HotelIndexDataset }
    : { ok: false, errors };
}

export const internals = {
  median,
  SAMPLE_WINDOW_DAYS,
  MIN_SAMPLES,
};
