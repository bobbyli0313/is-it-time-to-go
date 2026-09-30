/**
 * Shared test fixtures.
 *
 * Not a `.test.ts` file, so vitest does not treat it as a suite.
 *
 * Two things this module exists to prevent:
 *
 *  1. **Hardcoded dates.** The spec only allows departures within today..today+30,
 *     so any literal date in a test is a time bomb: it passes on the day it was
 *     written and fails a month later. Everything here derives from the real clock.
 *
 *  2. **The timezone trap.** "Today" must be resolved in the origin city's own
 *     timezone. At 04:00 UTC it is already the next calendar day in Shanghai, so a
 *     UTC-derived date lands one day outside the departure window and every test
 *     fails for a reason unrelated to what it is testing.
 */

import { CITIES, CITY_BY_ID } from "@/lib/data/cities";
import { addDays, todayForTrip } from "@/lib/scoring/dates";
import type { City, TripInput } from "@/lib/scoring/types";
import type { ScoreResponse } from "@/lib/api/contract";

export function city(id: string): City {
  const found = CITY_BY_ID.get(id);
  if (!found) throw new Error(`Unknown city fixture: ${id}`);
  return found;
}

export const SHANGHAI = city("shanghai");
export const TOKYO = city("tokyo");
export const BEIJING = city("beijing");

/** A fixed clock, so a test can pin "now" without pinning the calendar dates. */
export const FIXED_NOW = new Date();

/** Today in the origin's timezone, as the product itself computes it. */
export function today(origin: City = SHANGHAI): string {
  return todayForTrip(origin.timezone, origin.timezone, FIXED_NOW);
}

/**
 * ISO date `days` after today.
 *
 * Note this uses the Shanghai-anchored today, which is what the route validates
 * against for the routes under test. A test that needs a different origin's window
 * should call `today(origin)` explicitly.
 */
export function d(days: number): string {
  return addDays(today(), days);
}

export function trip(
  originCityId: string,
  destinationCityId: string,
  departOffset: number,
  returnOffset: number,
): TripInput {
  return {
    origin: city(originCityId),
    destination: city(destinationCityId),
    departDate: d(departOffset),
    returnDate: d(returnOffset),
  };
}

/**
 * Flattens a trip into the request body shape the route accepts.
 *
 * Callers name cities by id because that is what they assert against; the wire
 * contract carries what the *user* typed — an IATA code — so the ids are resolved
 * here. That keeps the tests exercising the same code path a browser does, rather
 * than a shortcut the app does not have.
 */
export function requestFor(
  originCityId: string,
  destinationCityId: string,
  departDate: string,
  returnDate: string,
) {
  return {
    originCode: city(originCityId).iataCity,
    destinationCode: city(destinationCityId).iataCity,
    departDate,
    returnDate,
  };
}

/** The same body, but with a code the app does not support. */
export const UNSUPPORTED_CODE = "ZZZ";

/**
 * Calls the scoring route handler directly.
 *
 * Using the handler rather than a live HTTP request keeps the suite fast and
 * hermetic while still exercising the real validation, provider resolution and
 * scoring path — which is the part worth testing. Server-to-server delivery is
 * covered by the live smoke test instead.
 */
export async function callScoreRoute(
  body: unknown,
): Promise<{ status: number; body: ScoreResponse }> {
  const { POST } = await import("@/app/api/score/route");
  const response = await POST(
    new Request("http://localhost/api/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as ScoreResponse,
  };
}

/** Convenience wrapper that asserts success and narrows the type. */
export async function scoreTripViaRoute(
  originCityId: string,
  destinationCityId: string,
  departDate: string,
  returnDate: string,
) {
  const { status, body } = await callScoreRoute(
    requestFor(originCityId, destinationCityId, departDate, returnDate),
  );
  if (!body.ok) {
    throw new Error(
      `Expected a successful score but got ${status}: ${body.error}`,
    );
  }
  return body;
}

/** Cities that participate in at least one route. */
export const ALL_ROUTE_CITIES = CITIES;
