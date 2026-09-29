/**
 * Route generation.
 *
 * Routes are derived rather than hand-listed: distance comes from real city
 * coordinates via the haversine formula (so it cannot drift out of sync with
 * `cities.ts`), and a per-route demand factor is what makes some city pairs
 * structurally expensive — a nonstop trunk route with heavy business demand is
 * priced very differently per mile from a thin leisure route.
 *
 * That per-mile variation is exactly why the scoring model prefers the fare's
 * *percentile within its own route history* over the spec's flat
 * `miles x $0.10` anchor. The anchor is still computed and shown, because it is
 * a useful sanity check on the mock data itself.
 */

import { CITIES, CITY_BY_ID } from "./cities";
import { haversineMiles, rngFor } from "./seed";
import type { City } from "../scoring/types";

export interface RouteSpec {
  id: string;
  originCityId: string;
  destinationCityId: string;
  /** Great-circle distance, statute miles, one way. */
  oneWayMiles: number;
  /** Round-trip distance. */
  roundTripMiles: number;
  /** Airport pair the mock fares are attributed to. */
  airportPair: [string, string];
  /**
   * Multiplier on the base per-mile fare, capturing demand and competition.
   * >1 means an expensive trunk or capacity-constrained route.
   */
  demandFactor: number;
  /** Typical round-trip fare in CNY at the median of the lookback window. */
  medianFareCny: number;
}

/** Curated demand factors for pairs where reality diverges from distance alone. */
const DEMAND_FACTORS: Record<string, number> = {
  // Heavy business + limited slot pairs: expensive per mile.
  "beijing|tokyo": 1.45,
  "shanghai|tokyo": 1.35,
  "beijing|seoul": 1.3,
  "shanghai|seoul": 1.25,
  "shanghai|hongkong": 1.2,
  "beijing|hongkong": 1.25,
  // Leisure routes with lots of low-cost capacity: cheap per mile.
  "guangzhou|bangkok": 0.72,
  "chengdu|bangkok": 0.78,
  "shanghai|bangkok": 0.82,
  "hongkong|bangkok": 0.75,
  "guangzhou|kualalumpur": 0.7,
  "shanghai|manila": 0.8,
  "hongkong|manila": 0.72,
  "hongkong|singapore": 0.85,
  "singapore|bali": 0.68,
  "kualalumpur|bali": 0.66,
  "bangkok|bali": 0.7,
  "bangkok|hanoi": 0.75,
  "bangkok|hochiminh": 0.73,
  "hanoi|hochiminh": 0.8,
  "bangkok|phuket": 0.78,
  "bangkok|chiangmai": 0.8,
  "seoul|tokyo": 1.15,
  "osaka|seoul": 1.1,
  "osaka|taipei": 0.95,
  "tokyo|sapporo": 1.05,
  "tokyo|osaka": 1.0,
  "taipei|hongkong": 0.9,
  "taipei|tokyo": 1.0,
  // Long-haul leisure within the region: cheaper per mile at distance.
  "beijing|bali": 0.62,
  "shanghai|bali": 0.6,
  "beijing|singapore": 0.7,
  // Domestic Chinese trunk routes: high frequency, heavily contested, cheap per mile.
  "beijing|shanghai": 1.15,
  "beijing|guangzhou": 1.1,
  "beijing|chengdu": 1.05,
  "shanghai|guangzhou": 1.0,
  "shanghai|chengdu": 0.95,
  "guangzhou|chengdu": 0.9,
  "shanghai|singapore": 0.68,
  "taipei|bali": 0.64,
  "seoul|bangkok": 0.72,
  "seoul|bali": 0.62,
  "seoul|singapore": 0.7,
  "busan|osaka": 0.95,
  "busan|tokyo": 1.0,
  "jakarta|singapore": 0.72,
  "jakarta|bali": 0.7,
  "jakarta|kualalumpur": 0.7,
  "manila|singapore": 0.72,
  "manila|hongkong": 0.72,
  "chiangmai|singapore": 0.7,
  "phuket|singapore": 0.72,
  "chengdu|singapore": 0.7,
  "guangzhou|singapore": 0.72,
};

/** The routes the prototype ships with. Extended later from real search demand. */
const ROUTE_PAIRS: Array<[string, string]> = [
  // Domestic Chinese trunk routes. Needed in their own right for the launch
  // scope, and also required for same-currency trips to be scorable at all.
  ["shanghai", "beijing"],
  ["shanghai", "guangzhou"],
  ["shanghai", "chengdu"],
  ["beijing", "guangzhou"],
  ["beijing", "chengdu"],
  ["guangzhou", "chengdu"],
  ["shanghai", "tokyo"],
  ["shanghai", "osaka"],
  ["shanghai", "seoul"],
  ["shanghai", "bangkok"],
  ["shanghai", "singapore"],
  ["shanghai", "hongkong"],
  ["shanghai", "bali"],
  ["shanghai", "manila"],
  ["shanghai", "taipei"],
  ["beijing", "tokyo"],
  ["beijing", "seoul"],
  ["beijing", "bangkok"],
  ["beijing", "singapore"],
  ["beijing", "hongkong"],
  ["beijing", "bali"],
  ["guangzhou", "bangkok"],
  ["guangzhou", "kualalumpur"],
  ["guangzhou", "singapore"],
  ["chengdu", "bangkok"],
  ["chengdu", "singapore"],
  ["hongkong", "tokyo"],
  ["hongkong", "bangkok"],
  ["hongkong", "singapore"],
  ["hongkong", "manila"],
  ["hongkong", "taipei"],
  ["tokyo", "seoul"],
  ["tokyo", "sapporo"],
  ["tokyo", "osaka"],
  ["tokyo", "taipei"],
  ["osaka", "seoul"],
  ["osaka", "taipei"],
  ["busan", "osaka"],
  ["busan", "tokyo"],
  ["seoul", "bangkok"],
  ["seoul", "singapore"],
  ["seoul", "bali"],
  ["bangkok", "singapore"],
  ["bangkok", "bali"],
  ["bangkok", "hanoi"],
  ["bangkok", "hochiminh"],
  ["bangkok", "phuket"],
  ["bangkok", "chiangmai"],
  ["hanoi", "hochiminh"],
  ["singapore", "bali"],
  ["singapore", "kualalumpur"],
  ["singapore", "manila"],
  ["singapore", "phuket"],
  ["singapore", "chiangmai"],
  ["kualalumpur", "bali"],
  ["jakarta", "singapore"],
  ["jakarta", "bali"],
  ["jakarta", "kualalumpur"],
  ["manila", "hongkong"],
  ["taipei", "bali"],
];

/** Canonical, order-independent key for a city pair. */
export function routeKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export function routeId(originId: string, destinationId: string): string {
  return `${originId}-${destinationId}`;
}

/**
 * Base round-trip fare in CNY for a route, before date-based variation.
 * Calibrated so short-haul Asian leisure routes land in the low hundreds of CNY
 * and long-haul trunk routes land in the low thousands — the range a real
 * cached-fare API would return for this region.
 */
function baseMedianFareCny(
  roundTripMiles: number,
  demandFactor: number,
): number {
  // Fixed component models airport taxes and fees, which do not scale with distance.
  const fixed = 380;
  const perMileCny = 0.42;
  return (fixed + roundTripMiles * perMileCny) * demandFactor;
}

function buildRoute(originId: string, destinationId: string): RouteSpec {
  const origin = CITY_BY_ID.get(originId);
  const destination = CITY_BY_ID.get(destinationId);
  if (!origin || !destination) {
    throw new Error(`Unknown city in route ${originId} -> ${destinationId}`);
  }

  const oneWayMiles = haversineMiles(
    origin.lat,
    origin.lon,
    destination.lat,
    destination.lon,
  );
  const roundTripMiles = Math.round(oneWayMiles * 2);

  const key = routeKey(originId, destinationId);
  const demandFactor =
    DEMAND_FACTORS[key] ??
    // Unlisted pairs get a mild, deterministic variation so the set is not uniform.
    0.85 + rngFor("demand", key)() * 0.3;

  return {
    id: routeId(originId, destinationId),
    originCityId: originId,
    destinationCityId: destinationId,
    oneWayMiles: Math.round(oneWayMiles),
    roundTripMiles,
    /**
     * Airports in the *same order as the route*, origin first. The reverse direction
     * resolves to the same route object, so an unnormalised pair would send a fare
     * query for HND->TPE when the user asked for TPE->HND — the same price, but
     * confusing in logs and wrong if the two directions ever price differently.
     */
    airportPair: [origin.airports[0], destination.airports[0]],
    demandFactor: Math.round(demandFactor * 100) / 100,
    medianFareCny: Math.round(
      baseMedianFareCny(roundTripMiles, demandFactor),
    ),
  };
}

export const ROUTES: RouteSpec[] = ROUTE_PAIRS.map(([a, b]) =>
  buildRoute(a, b),
);

const ROUTE_INDEX = new Map(
  ROUTES.flatMap((r) => [
    [`${r.originCityId}->${r.destinationCityId}`, r] as const,
    [`${r.destinationCityId}->${r.originCityId}`, r] as const,
  ]),
);

/**
 * Looks up a route in either direction.
 *
 * Pricing is symmetric in this prototype, so the reverse direction returns the same
 * route object with its airport pair *flipped to match the request*. Callers can then
 * use `airportPair` directly as [from, to] without re-deriving the order, which is what
 * keeps a fare query pointed at the direction the user actually asked for.
 */
export function findRoute(
  originCityId: string,
  destinationCityId: string,
): RouteSpec | undefined {
  const forward = ROUTE_INDEX.get(`${originCityId}->${destinationCityId}`);
  if (forward) return forward;

  const reverse = ROUTE_INDEX.get(`${destinationCityId}->${originCityId}`);
  if (!reverse) return undefined;

  return {
    ...reverse,
    id: routeId(originCityId, destinationCityId),
    originCityId,
    destinationCityId,
    airportPair: [reverse.airportPair[1], reverse.airportPair[0]],
  };
}

export function hasRoute(a: string, b: string): boolean {
  return findRoute(a, b) !== undefined;
}

/**
 * Every city reachable from `originId` within the launch scope, in both
 * directions, de-duplicated and excluding the origin itself.
 */
export function destinationsFrom(originId: string): City[] {
  const ids = new Set<string>();
  for (const route of ROUTES) {
    if (route.originCityId === originId) ids.add(route.destinationCityId);
    if (route.destinationCityId === originId) ids.add(route.originCityId);
  }
  return [...ids]
    .map((id) => CITY_BY_ID.get(id))
    .filter((c): c is City => c !== undefined)
    .sort((a, b) => a.name.en.localeCompare(b.name.en));
}

/** All cities that appear in at least one route. */
export function connectedCities(): City[] {
  const ids = new Set<string>();
  for (const route of ROUTES) {
    ids.add(route.originCityId);
    ids.add(route.destinationCityId);
  }
  return CITIES.filter((c) => ids.has(c.id));
}
