/**
 * Dataset merging and atomic replacement.
 *
 * Both writers — the CLI and the on-demand collector that now runs on the request path
 * — need the same two guarantees, and they are not optional:
 *
 *  1. **Merge, never overwrite.** Collection is per city and per date, so a run that
 *     replaces the file wholesale deletes every city it did not just collect. That is
 *     not hypothetical: an early CLI run for a single city silently wiped the rest of
 *     the dataset, and the only reason it was noticed is that the output said "0
 *     cities". Merging by `(propertyId, date, source)` makes a partial run additive,
 *     which is what "collect this city" is supposed to mean.
 *  2. **Replace atomically.** A request path and a CLI run can write concurrently, and
 *     a crash mid-write must not leave a half-written JSON file where the read side
 *     expects a dataset. Writes go to a temporary file in the same directory and are
 *     renamed over the target, which is atomic on POSIX filesystems.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DATASET_VERSION,
  DEFAULT_BASIS,
  type CityHotelCensus,
  type HotelDataset,
  type HotelDisclosure,
  type HotelPriceSample,
  type HotelProperty,
} from "../hotel-dataset";

/** Identity of a sample: the same property, night and source is the same observation. */
function sampleKey(sample: HotelPriceSample): string {
  return `${sample.propertyId}|${sample.date}|${sample.source}`;
}

export interface MergeInput {
  basis?: HotelDataset["basis"];
  disclosure?: HotelDisclosure;
  cities: CityHotelCensus[];
  samples: HotelPriceSample[];
  generatedAt?: string;
}

/**
 * Folds a collection result into an existing dataset.
 *
 * Cities are merged property-by-property (a later run may find hotels an earlier one
 * did not), and samples are de-duplicated by `(property, date, source)` so re-running a
 * collection refreshes a price rather than stacking a second copy of it — which would
 * otherwise let a city's weight in the median depend on how often it was collected.
 */
export function mergeDataset(
  existing: HotelDataset | null,
  input: MergeInput,
): HotelDataset {
  const byCity = new Map<string, CityHotelCensus>();

  for (const city of existing?.cities ?? []) {
    byCity.set(city.cityId, { ...city, properties: [...city.properties] });
  }

  for (const incoming of input.cities) {
    const current = byCity.get(incoming.cityId);
    if (!current) {
      byCity.set(incoming.cityId, { ...incoming, properties: [...incoming.properties] });
      continue;
    }

    const known = new Set(current.properties.map((p) => p.id));
    const added: HotelProperty[] = incoming.properties.filter((p) => !known.has(p.id));

    byCity.set(incoming.cityId, {
      ...incoming,
      properties: [...current.properties, ...added],
      // A census stays "complete" only if it still describes one universe; a merge of
      // two partial lists is not a complete one.
      censusComplete: current.censusComplete && incoming.censusComplete,
      censusSource: [current.censusSource, incoming.censusSource]
        .filter(Boolean)
        .join("+") || undefined,
    });
  }

  const samples = new Map<string, HotelPriceSample>();
  for (const sample of existing?.samples ?? []) samples.set(sampleKey(sample), sample);
  for (const sample of input.samples) samples.set(sampleKey(sample), sample);

  return {
    version: DATASET_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    basis: input.basis ?? existing?.basis ?? { ...DEFAULT_BASIS },
    // The most restrictive disclosure wins: one source that may not be republished
    // makes the whole dataset an index.
    disclosure:
      input.disclosure === "index" || existing?.disclosure === "index"
        ? "index"
        : (input.disclosure ?? existing?.disclosure ?? "price"),
    cities: [...byCity.values()].sort((a, b) => a.cityId.localeCompare(b.cityId)),
    samples: [...samples.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.propertyId.localeCompare(b.propertyId),
    ),
  };
}

/** Writes the dataset, replacing any existing file in one step. */
export async function writeDatasetAtomic(
  path: string,
  dataset: HotelDataset,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
