/**
 * File-backed dataset store.
 *
 * The dataset is a JSON file rather than a table because the volume is small
 * (cities × properties × dates), it can be reviewed in a diff, and an operator can
 * hand-edit a bad row. This module is the only place that knows that.
 *
 * Two behaviours worth stating:
 *
 *  - **Reload on change.** The file's mtime is checked on every load, so dropping
 *    in a freshly collected dataset takes effect without a restart. The parsed
 *    value is cached between loads because parsing a few hundred kilobytes on
 *    every request would be wasteful.
 *  - **A malformed file degrades, it does not break.** On a request path, invalid
 *    data yields an empty dataset, which the scorer renders as "hotel pricing not
 *    available" — the honest outcome. Throwing instead would turn a bad file into
 *    a failed request for every trip. `strict` flips that for the CLI, where
 *    failing loudly is the point.
 */

import { readFile, stat } from "node:fs/promises";
import {
  emptyDataset,
  validateDataset,
  type HotelDataset,
  type HotelDatasetStore,
} from "./hotel-dataset";

export interface FileStoreOptions {
  /** Log a line per load. Defaults to off; the CLI turns it on. */
  verbose?: boolean;
  /** Throw on invalid content instead of degrading to an empty dataset. */
  strict?: boolean;
  log?: (message: string) => void;
}

export interface FileStore extends HotelDatasetStore {
  readonly path: string;
  /** True when the most recent load had to fall back to an empty dataset. */
  lastLoadWasFallback(): boolean;
  lastErrors(): string[];
}

export function createFileStore(
  path: string,
  options: FileStoreOptions = {},
): FileStore {
  const log = options.log ?? (options.verbose ? console.log : () => {});
  let cached: { mtimeMs: number; dataset: HotelDataset } | null = null;
  let fellBack = false;
  let errors: string[] = [];

  async function load(): Promise<HotelDataset> {
    let mtimeMs: number;
    try {
      const info = await stat(path);
      mtimeMs = info.mtimeMs;
    } catch {
      // No dataset yet is the normal state before the first collection run.
      fellBack = true;
      errors = [`no dataset at ${path}`];
      log(`hotel dataset: none at ${path}; hotel pricing unavailable`);
      return emptyDataset();
    }

    if (cached && cached.mtimeMs === mtimeMs) return cached.dataset;

    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return degrade([`${path} is not valid JSON: ${String(error)}`]);
    }

    const result = validateDataset(parsed);
    if (!result.ok) return degrade(result.errors);

    fellBack = false;
    errors = [];
    cached = { mtimeMs, dataset: result.data };
    log(
      `hotel dataset: ${result.data.cities.length} cities, ${result.data.samples.length} samples`,
    );
    return result.data;
  }

  function degrade(problems: string[]): HotelDataset {
    fellBack = true;
    errors = problems;
    if (options.strict) {
      throw new Error(`Invalid hotel dataset at ${path}: ${problems.join("; ")}`);
    }
    console.error(
      `[iittg] hotel dataset at ${path} is unusable, hotel pricing excluded:\n  - ${problems.join("\n  - ")}`,
    );
    return emptyDataset();
  }

  return {
    path,
    load,
    lastLoadWasFallback: () => fellBack,
    lastErrors: () => errors,
  };
}
