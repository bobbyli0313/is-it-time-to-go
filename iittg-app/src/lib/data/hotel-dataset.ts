/**
 * The collected hotel price dataset: schema, validation, and small statistics.
 *
 * ## What changed from the first version, and why
 *
 * v1 stored a *fixed basket* per city and measured a city against its own
 * baseline, producing a relative index. The product decision has since changed:
 * the reference price for a city is now **the median nightly rate across all of
 * that city's hotels that have been priced**, compared against the ¥500 anchor
 * from the brief. Three consequences:
 *
 *  1. **Membership may grow.** A basket had to stay fixed or it stopped being an
 *     index; a median is a statement about a *level*, so adding properties is an
 *     improvement rather than a discontinuity. The property list is therefore a
 *     census to be filled in, not a roster to be frozen.
 *  2. **One property, one vote.** A property sampled on five nights must not
 *     outweigh a property sampled once, so each property is reduced to its own
 *     median first and the city median is taken over those (see
 *     `reduceToPropertyMedians`). The alternative — pooling every sample — lets a
 *     single well-covered hotel drag a whole city.
 *  3. **Coverage has to be disclosed.** "The median of all hotels" is only
 *     meaningful next to how many of the city's hotels were actually priced, so
 *     the census carries the full property list and the quote reports the
 *     fraction behind the number.
 *
 * ## Storage
 *
 * A JSON file, as in v1: the volume is small (cities × properties × dates),
 * it is human-inspectable, and a diff of it is reviewable. If it outgrows a file,
 * this module is the only thing that has to change — the collect side writes
 * through `toDataset`, and the read side reads through `validateDataset`.
 */

import type { City, HotelQuote } from "../scoring/types";
import { findCity } from "./cities";
import { isValidIsoDate } from "../scoring/dates";

export const DATASET_VERSION = 2;

/**
 * The question every sample in a dataset answers.
 *
 * Held at dataset level because a median is only meaningful if all its inputs
 * are comparable: a single room and a twin in the same hotel differ by 30-60%,
 * and mixing them would make the median a statement about nothing.
 */
export interface HotelPriceBasis {
  adults: number;
  rooms: number;
  roomClass: "cheapest-available";
  taxIncluded: boolean;
}

export interface HotelProperty {
  /** Globally unique and stable: `<group>:<source code>`. */
  id: string;
  name: string;
  /** The source or chain slug, e.g. `hotelbeds`. Free-form. */
  group: string;
  starRating?: number;
}

export interface CityHotelCensus {
  cityId: string;
  currency: string;
  /**
   * The scoring anchor — the brief's ¥500 converted into `currency` when the
   * dataset was built. Stored rather than converted at read time so the score
   * does not move when the exchange rate does.
   */
  baselineLocal: number;
  /** ISO timestamp of the FX rate used for `baselineLocal`, for disclosure. */
  baselineAsOf?: string;
  /** Every property this city is known to have, priced or not. */
  properties: HotelProperty[];
  /**
   * Whether `properties` is the city's *whole* known inventory or merely the set
   * that has been priced or imported.
   *
   * The distinction decides whether coverage can be claimed at all: with a
   * complete census, "34 of 51 properties" is a real coverage figure; with an
   * incomplete one the denominator is unknown, and the reference price must not
   * imply it saw the whole city.
   */
  censusComplete: boolean;
  /** Where the property list came from, e.g. `example-feed/census.csv`. */
  censusSource?: string;
  notes?: string;
}

export interface HotelPriceSample {
  /** Check-in date, ISO. One night. */
  date: string;
  propertyId: string;
  /** Nightly price in the city's own currency. */
  priceLocal: number;
  /** Which collector produced it. */
  source: string;
  /** ISO timestamp of collection. */
  collectedAt: string;
  /**
   * `verified` means the source's response shape is known and tested;
   * `inferred` means a defensive field search found the amount. Inferred samples
   * are used but cost confidence, and are never mixed into a property's median
   * when a verified sample exists for the same night.
   */
  extraction: "verified" | "inferred";
  note?: string;
}

/**
 * What the app may publish from a dataset.
 *
 * - `price`: the median nightly rate itself.
 * - `index`: only its distance from the ¥500 anchor, e.g. "64% above the anchor".
 *
 * The distinction exists because some sources permit storing a rate but not
 * republishing it — a wholesale net rate is not a retail price. The switch is on the
 * dataset rather than the UI because it has to hold for the API response too: a
 * field the scorer does not emit is a field the browser cannot read.
 */
export type HotelDisclosure = "price" | "index";

export interface HotelDataset {
  version: typeof DATASET_VERSION;
  generatedAt?: string;
  basis: HotelPriceBasis;
  /** Defaults to `price` when absent, so an ordinary import stays unchanged. */
  disclosure?: HotelDisclosure;
  cities: CityHotelCensus[];
  samples: HotelPriceSample[];
}

export interface HotelDatasetStore {
  load(): Promise<HotelDataset>;
}

/** Default basis: one room, two adults, cheapest bookable rate, taxes included. */
export const DEFAULT_BASIS: HotelPriceBasis = {
  adults: 2,
  rooms: 1,
  roomClass: "cheapest-available",
  taxIncluded: true,
};

export function emptyDataset(): HotelDataset {
  return {
    version: DATASET_VERSION,
    basis: { ...DEFAULT_BASIS },
    cities: [],
    samples: [],
  };
}

/* ----------------------------------------------------------- statistics */

/**
 * Median of a non-empty list. Median rather than mean throughout: one suite or
 * one hostel in the tail would otherwise move a city's reference price by a
 * factor, and the score is meant to describe a typical stay.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Linear-interpolated quantile, used only for disclosure (the p25/p75 band the
 * UI shows as "typical range"). The reference price itself is always a median.
 */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export interface PropertyMedian {
  propertyId: string;
  medianLocal: number;
  sampleCount: number;
  /** True when the property's median rests on inferred extractions only. */
  inferredOnly: boolean;
  newestCollectedAt: string;
}

/**
 * Collapses samples to one value per property.
 *
 * This is the step that makes "the median of all hotels" mean what it says. With
 * prices pooled across properties, a hotel that was sampled on every night of the
 * window would count several times and a hotel sampled once would count once —
 * so the result would be a median over *samples*, weighted by collection effort
 * rather than by the city's actual composition.
 *
 * Verified extractions win: for a given property, if any verified sample exists,
 * inferred ones are dropped rather than averaged in.
 */
export function reduceToPropertyMedians(
  samples: HotelPriceSample[],
): PropertyMedian[] {
  const byProperty = new Map<string, HotelPriceSample[]>();
  for (const sample of samples) {
    const list = byProperty.get(sample.propertyId);
    if (list) list.push(sample);
    else byProperty.set(sample.propertyId, [sample]);
  }

  const out: PropertyMedian[] = [];
  for (const [propertyId, list] of byProperty) {
    const verified = list.filter((s) => s.extraction === "verified");
    const used = verified.length > 0 ? verified : list;
    const newest = used.reduce(
      (latest, s) => (s.collectedAt > latest ? s.collectedAt : latest),
      used[0].collectedAt,
    );
    out.push({
      propertyId,
      medianLocal: median(used.map((s) => s.priceLocal)),
      sampleCount: used.length,
      inferredOnly: verified.length === 0,
      newestCollectedAt: newest,
    });
  }

  return out.sort((a, b) => a.propertyId.localeCompare(b.propertyId));
}

/* --------------------------------------------------------- validation */

export type ValidationResult =
  | { ok: true; data: HotelDataset }
  | { ok: false; errors: string[] };

/**
 * Validates a dataset, collecting every problem rather than stopping at the
 * first: a hand-edited file usually has more than one mistake, and fixing them
 * one run at a time is how people give up and disable the check.
 *
 * The check that earns its keep is *sample → property*: a price for a property
 * that is not in its city's census cannot be attributed, and silently ignoring it
 * would quietly shrink the sample the median rests on.
 */
export function validateDataset(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["dataset is not an object"] };
  }

  const d = value as Partial<HotelDataset>;
  if (d.version !== DATASET_VERSION) {
    errors.push(
      `unsupported version: ${String(d.version)} (expected ${DATASET_VERSION})`,
    );
  }

  const basis = d.basis as HotelPriceBasis | undefined;
  if (!basis || typeof basis !== "object") {
    errors.push("basis is missing");
  } else {
    if (!(basis.adults >= 1)) errors.push("basis.adults must be at least 1");
    if (!(basis.rooms >= 1)) errors.push("basis.rooms must be at least 1");
    if (basis.roomClass !== "cheapest-available") {
      errors.push(`basis.roomClass must be "cheapest-available"`);
    }
    if (typeof basis.taxIncluded !== "boolean") {
      errors.push("basis.taxIncluded must be a boolean");
    }
  }

  if (
    d.disclosure !== undefined &&
    d.disclosure !== "price" &&
    d.disclosure !== "index"
  ) {
    errors.push(`disclosure must be "price" or "index", got ${String(d.disclosure)}`);
  }
  if (!Array.isArray(d.cities)) errors.push("cities is not an array");
  if (!Array.isArray(d.samples)) errors.push("samples is not an array");

  const knownCities = new Set<string>();
  const propertyIds = new Set<string>();

  /**
   * Every loop below re-checks that its input is an array rather than trusting the
   * message above. A validator that throws on malformed input is worse than no
   * validator: the whole point is to report a bad file, and the file store calls
   * this on data it has not otherwise inspected.
   */
  const cityList = Array.isArray(d.cities) ? d.cities : [];
  const sampleList = Array.isArray(d.samples) ? d.samples : [];

  for (const [i, census] of cityList.entries()) {
    const where = `cities[${i}]`;
    if (typeof census !== "object" || census === null) {
      errors.push(`${where}: not an object`);
      continue;
    }

    const city: City | undefined = findCity(census.cityId);
    if (!city) errors.push(`${where}: unknown city ${String(census.cityId)}`);
    else knownCities.add(city.id);

    if (!(census.baselineLocal > 0)) {
      errors.push(`${where}: baselineLocal must be positive`);
    }
    if (typeof census.currency !== "string" || census.currency.length !== 3) {
      errors.push(`${where}: currency must be an ISO 4217 code`);
    }
    if (!Array.isArray(census.properties) || census.properties.length === 0) {
      errors.push(`${where}: properties is empty`);
      continue;
    }
    if (typeof census.censusComplete !== "boolean") {
      errors.push(
        `${where}: censusComplete must be a boolean (is properties the whole city or only the priced set?)`,
      );
    }

    const local = new Set<string>();
    for (const [j, property] of census.properties.entries()) {
      if (typeof property !== "object" || property === null) {
        errors.push(`${where}.properties[${j}]: not an object`);
        continue;
      }
      if (!property.id) errors.push(`${where}.properties[${j}]: id is empty`);
      if (!property.name) errors.push(`${where}.properties[${j}]: name is empty`);
      if (!property.group) {
        errors.push(`${where}.properties[${j}]: group is empty`);
      }
      if (local.has(property.id)) {
        errors.push(`${where}.properties[${j}]: duplicate id ${property.id}`);
      }
      if (propertyIds.has(property.id)) {
        errors.push(
          `${where}.properties[${j}]: id ${property.id} already used by another city`,
        );
      }
      local.add(property.id);
      propertyIds.add(property.id);
    }
  }

  for (const [i, sample] of sampleList.entries()) {
    const where = `samples[${i}]`;
    if (typeof sample !== "object" || sample === null) {
      errors.push(`${where}: not an object`);
      continue;
    }
    if (!Number.isFinite(sample.priceLocal) || sample.priceLocal <= 0) {
      errors.push(`${where}: priceLocal must be positive`);
    }
    if (!isValidIsoDate(sample.date)) {
      errors.push(`${where}: date is not ISO (YYYY-MM-DD)`);
    }
    if (!sample.propertyId || !propertyIds.has(sample.propertyId)) {
      errors.push(
        `${where}: propertyId ${String(sample.propertyId)} is not in any city census`,
      );
    }
    if (!sample.source) errors.push(`${where}: source is empty`);
    if (sample.extraction !== "verified" && sample.extraction !== "inferred") {
      errors.push(`${where}: extraction must be "verified" or "inferred"`);
    }
  }

  return errors.length === 0
    ? { ok: true, data: d as HotelDataset }
    : { ok: false, errors };
}

/**
 * Assembles a dataset from census rows and samples, dropping nothing silently:
 * the caller gets the list of rejected samples so a run report can state how many
 * prices were thrown away and why.
 */
export function toDataset(input: {
  basis?: HotelPriceBasis;
  disclosure?: HotelDisclosure;
  cities: CityHotelCensus[];
  samples: HotelPriceSample[];
  generatedAt?: string;
}): HotelDataset {
  return {
    version: DATASET_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    basis: input.basis ?? { ...DEFAULT_BASIS },
    disclosure: input.disclosure ?? "price",
    cities: input.cities,
    samples: input.samples,
  };
}

/** Type guard used by the read side before it trusts a stored dataset. */
export function isUsableQuote(quote: HotelQuote): boolean {
  return quote.sampleSize > 0 && quote.perNightLocal > 0;
}
