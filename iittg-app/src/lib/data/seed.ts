/**
 * Deterministic pseudo-randomness.
 *
 * The mock data set must be *stable across runs and machines*: the same route
 * and date has to produce the same fare every time, or the UI flickers, the
 * tests flake, and screenshots stop matching. So every generator is seeded from
 * a hash of its own inputs rather than from `Math.random()`.
 */

/** FNV-1a. Small, fast, and good enough to spread route keys. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — 32-bit PRNG with a decent distribution for mock data. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(...parts: Array<string | number>): () => number {
  return makeRng(hashString(parts.join("|")));
}

/** Uniform float in [min, max). */
export function between(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Approximately normal via the sum of three uniforms (Bates distribution). */
export function bellish(rng: () => number): number {
  return (rng() + rng() + rng()) / 3;
}

/* ------------------------------------------------------------ geo helpers */

const EARTH_RADIUS_MILES = 3958.7613;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in statute miles. */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}
