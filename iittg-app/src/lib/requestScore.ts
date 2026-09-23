/**
 * The one call the UI makes to get a score.
 *
 * Right now this runs entirely in the browser because the data provider is
 * in-memory mock data — no network, no keys, instant. That is a deliberate
 * prototype choice, not the target architecture.
 *
 * The target architecture keeps this exact function signature but moves the body
 * server-side (a route handler), because scoring will require API keys that must
 * never ship to the client, and because results must be cached in Redis keyed by
 * `(origin, destination, dateRange)` rather than recomputed per visitor. Every
 * caller is written against this signature so that move is a one-file change.
 */

import { scoreTrip } from "./scoring";
import { buildScoreContext } from "./data/provider";
import { isValidIsoDate, diffDays } from "./scoring/dates";
import { MAX_TRIP_DAYS, dateWindow } from "./format";
import { findCity } from "./data/cities";
import { hasHolidayCoverage } from "./data/holidays";
import { hasRoute } from "./data/routes";
import type { ScoreResult, TripInput } from "./scoring/types";

export type ScoreRequest = {
  originCityId: string;
  destinationCityId: string;
  departDate: string;
  returnDate: string;
  travellers?: number;
};

export type ScoreResponse =
  | {
      ok: true;
      result: ScoreResult;
      trip: {
        originName: { en: string; zh: string };
        destinationName: { en: string; zh: string };
        departDate: string;
        returnDate: string;
        originCurrency: string;
        destinationCurrency: string;
        airportPair: [string, string];
      };
      /** Non-fatal data-quality notes the UI must show rather than hide. */
      dataNotes: string[];
    }
  | { ok: false; error: string };

export async function requestScore(
  request: ScoreRequest,
  now: Date = new Date(),
): Promise<ScoreResponse> {
  const origin = findCity(request.originCityId);
  const destination = findCity(request.destinationCityId);

  if (!origin || !destination) {
    return { ok: false, error: "form.routeUnavailable" };
  }
  if (origin.id === destination.id) {
    return { ok: false, error: "form.routeUnavailable" };
  }
  if (!hasRoute(origin.id, destination.id)) {
    return { ok: false, error: "form.routeUnavailable" };
  }
  if (
    !isValidIsoDate(request.departDate) ||
    !isValidIsoDate(request.returnDate)
  ) {
    return { ok: false, error: "form.dateRange" };
  }

  const { min, max } = dateWindow(origin.timezone, now);

  // Which calendar day it is depends on where the traveller is standing.
  if (request.departDate < min || request.departDate > max) {
    return { ok: false, error: "form.dateRange" };
  }
  if (request.returnDate < request.departDate) {
    return { ok: false, error: "form.returnBeforeDepart" };
  }
  if (diffDays(request.departDate, request.returnDate) + 1 > MAX_TRIP_DAYS) {
    return { ok: false, error: "form.returnBeforeDepart" };
  }

  const trip: TripInput = {
    origin,
    destination,
    departDate: request.departDate,
    returnDate: request.returnDate,
    travellers: request.travellers ?? 1,
  };

  const context = await buildScoreContext(trip, now);

  // Holiday coverage gaps would silently read as "no crowding", so they are
  // surfaced as a data note instead.
  const dataNotes: string[] = [];
  const years = new Set([
    request.departDate.slice(0, 4),
    request.returnDate.slice(0, 4),
  ]);
  for (const year of years) {
    if (!hasHolidayCoverage(Number(year))) {
      dataNotes.push("warning.holidayCoverageIncomplete");
      break;
    }
  }

  const result = scoreTrip(trip, context);

  return {
    ok: true,
    result,
    trip: {
      originName: origin.name,
      destinationName: destination.name,
      departDate: request.departDate,
      returnDate: request.returnDate,
      originCurrency: origin.currency,
      destinationCurrency: destination.currency,
      airportPair: [
        origin.airports[0] ?? origin.iataCity,
        destination.airports[0] ?? destination.iataCity,
      ],
    },
    dataNotes,
  };
}
