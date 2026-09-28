/**
 * TTL cache with single-flight de-duplication.
 *
 * This is a hard requirement rather than an optimisation. One scored trip is
 * 4-6 upstream calls, so ten users exploring ten candidate date ranges is several
 * hundred calls; without caching the free tiers are exhausted in a day. It also
 * solves a concrete latency problem: Open-Meteo's historical archive takes 7-10
 * seconds per request, which is unusable on a request path but perfectly fine once
 * per city per month.
 *
 * Two layers:
 *  - memory, so repeat hits within a process are free.
 *  - disk, so a dev-server restart does not re-pay for slow upstream calls, and so
 *    a single long-lived scorer process keeps a warm cache across deploys.
 *
 * Single-flight matters more than it looks: without it, N concurrent requests for
 * the same cold key produce N upstream calls, which is exactly the stampede that
 * exhausts a quota.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CacheEntry<T> {
  value: T;
  /** Epoch millis. */
  expiresAt: number;
  /** Epoch millis the value was produced. Surfaced to the UI as data freshness. */
  storedAt: number;
}

interface MemoryRecord {
  entry: CacheEntry<unknown>;
}

const memory = new Map<string, MemoryRecord>();

/** In-flight promises, keyed identically to the cache. Enables single-flight. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Cache directory, resolved per call rather than captured at import time.
 *
 * Module-level capture was a real bug source: vitest injects `test.env` after the
 * module graph is evaluated, so an import-time constant read a different value in
 * tests than in the server. Resolving lazily also lets a test point the cache at its
 * own temporary directory, which is how the disk layer finally got covered.
 */
export function cacheDir(): string {
  return (
    process.env.IITTG_CACHE_DIR ?? join(process.cwd(), ".cache", "iittg")
  );
}

/**
 * Disk persistence is on unless explicitly disabled.
 *
 * Passing an explicit `dir` forces it on, so a test can exercise the real disk path
 * without depending on the ambient environment.
 */
function diskEnabled(dir?: string): boolean {
  if (dir !== undefined) return true;
  return process.env.IITTG_CACHE_DISK !== "0";
}

const diskReady = new Map<string, Promise<void>>();

function ensureDisk(dir: string): Promise<void> {
  let ready = diskReady.get(dir);
  if (!ready) {
    ready = mkdir(dir, { recursive: true }).then(
      () => undefined,
      () => undefined, // A read-only filesystem must not break scoring.
    );
    diskReady.set(dir, ready);
  }
  return ready;
}

function safeFileName(key: string): string {
  // Hash keeps names filesystem-safe and bounded regardless of the key's shape.
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

function isFresh(entry: CacheEntry<unknown>, now: number): boolean {
  return entry.expiresAt > now;
}

export interface RememberOptions {
  /** How long the value stays fresh. */
  ttlMs: number;
  /**
   * Whether to keep serving a stale value when the loader throws. Intended for
   * slow, rarely-changing upstreams such as climate normals: a week-old answer is
   * far better than a failed request.
   */
  staleOnError?: boolean;
  /** Overrides the disk directory. Tests point this at a temp folder. */
  dir?: string;
}

async function readFromDisk<T>(
  key: string,
  dir?: string,
): Promise<CacheEntry<T> | null> {
  if (!diskEnabled(dir)) return null;
  const target = dir ?? cacheDir();
  await ensureDisk(target);
  try {
    const raw = await readFile(join(target, safeFileName(key)), "utf8");
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (typeof parsed?.expiresAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeToDisk<T>(
  key: string,
  entry: CacheEntry<T>,
  dir?: string,
): Promise<void> {
  if (!diskEnabled(dir)) return;
  const target = dir ?? cacheDir();
  await ensureDisk(target);
  try {
    await writeFile(
      join(target, safeFileName(key)),
      JSON.stringify(entry),
      "utf8",
    );
  } catch {
    // Cache writes are best-effort by definition.
  }
}

/** Reads a fresh value, checking memory then disk. */
export async function cacheGet<T>(
  key: string,
  now: number = Date.now(),
  dir?: string,
): Promise<CacheEntry<T> | null> {
  const hit = memory.get(key);
  if (hit && isFresh(hit.entry, now)) return hit.entry as CacheEntry<T>;

  const fromDisk = await readFromDisk<T>(key, dir);
  if (fromDisk) {
    // Warm memory even when stale, so the stale fallback path can use it.
    memory.set(key, { entry: fromDisk });
    if (isFresh(fromDisk, now)) return fromDisk;
  }
  return null;
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlMs: number,
  now: number = Date.now(),
  dir?: string,
): Promise<CacheEntry<T>> {
  const entry: CacheEntry<T> = {
    value,
    storedAt: now,
    expiresAt: now + ttlMs,
  };
  memory.set(key, { entry });
  await writeToDisk(key, entry, dir);
  return entry;
}

/**
 * Returns the cached value if fresh, otherwise calls `loader` exactly once even
 * under concurrent demand, then caches the result.
 */
export async function remember<T>(
  key: string,
  loader: () => Promise<T>,
  options: RememberOptions,
): Promise<T> {
  const now = Date.now();
  const fresh = await cacheGet<T>(key, now, options.dir);
  if (fresh) return fresh.value;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    try {
      const value = await loader();
      await cacheSet(key, value, options.ttlMs, Date.now(), options.dir);
      return value;
    } catch (error) {
      if (options.staleOnError) {
        // Deliberately ignoring expiry here: a stale answer beats no answer for
        // data that changes slowly, and the caller reports its age to the UI.
        const stale =
          (memory.get(key)?.entry as CacheEntry<T> | undefined) ??
          (await readFromDisk<T>(key, options.dir).catch(() => null));
        if (stale) return stale.value;
      }
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/** Test helper: drops all in-memory state. Disk state is left alone. */
export function clearMemoryCache(): void {
  memory.clear();
  inFlight.clear();
}

/* --------------------------------------------------------------- durations */

export const TTL = {
  /** Numerical forecasts update a few times a day. */
  forecast: 30 * 60_000,
  /**
   * Climate normals change on the scale of decades. A long TTL is the whole point:
   * the upstream archive takes 7-10 seconds per request.
   */
  climateNormal: 30 * 24 * 3_600_000,
  /** Published holiday calendars change rarely, but new years get added. */
  holidays: 7 * 24 * 3_600_000,
  /** ECB reference rates are published once per working day. */
  fxLatest: 6 * 3_600_000,
  /** The trailing 12-month range only needs recomputing daily. */
  fxYearRange: 24 * 3_600_000,
  /** Fares move constantly; this is the staleness the UI discloses. */
  flightQuote: 6 * 3_600_000,
  /** Hotel indices are relative and move slowly. */
  hotelIndex: 12 * 3_600_000,
} as const;
