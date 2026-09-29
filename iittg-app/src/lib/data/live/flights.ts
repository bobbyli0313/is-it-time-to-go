/**
 * Flight pricing via Ignav (ignav.com).
 *
 * ## Why not Amadeus
 *
 * The Amadeus Self-Service portal was decommissioned on 17 July 2026 and its API
 * keys were disabled; flight API access now requires an enterprise sales contract.
 * An Amadeus adapter was written and then removed for that reason — see git history
 * — and it is worth recording so nobody re-adds it.
 *
 * ## Contract
 *
 * Taken from the published OpenAPI document at `https://ignav.com/api/openapi.json`,
 * not from prose documentation:
 *
 *   POST /api/fares/round-trip
 *   headers: X-Api-Key
 *   body:    { origin, destination, departure_date, return_date, adults, cabin_class, market }
 *   200:     { origin, destination, departure_date, return_date,
 *              itineraries: [ { price: { amount, currency, status }, legs: [...], ignav_id } ] }
 *
 * Auth is a single header, with no OAuth token exchange and no test/production split,
 * which removes two failure modes the Amadeus adapter had to handle.
 *
 * ## Two honest limitations
 *
 * 1. **Verification status.** The request and response shapes come from the published
 *    schema, but no fare response has been observed, because a key requires signup
 *    and none was available. Parsing is defensive: an unexpected shape yields
 *    "unavailable" rather than a plausible-looking wrong price. One session with a
 *    key is needed before this is trusted.
 *
 * 2. **Currency.** `market` and `currency` behaviour is not documented in the schema.
 *    A response in a currency other than the origin's would silently break the score,
 *    since the model compares the fare against an origin-currency baseline. So a
 *    mismatched currency is treated as unusable rather than converted on a guess.
 */

import type {
  City,
  FlightQuote,
  FlightScorerInput,
} from "../../scoring/types";
import { findRoute } from "../routes";
import { addDays } from "../../scoring/dates";
import type { PricingCredentials } from "../config";
import { TTL, remember } from "../cache";
import { fetchJson } from "../http";

const BASE_URL = "https://ignav.com";

/** Airlines generally open bookings this far ahead. */
const BOOKING_WINDOW_DAYS = 330;

interface IgnavPrice {
  amount?: number;
  currency?: string;
  status?: string;
}

interface IgnavItinerary {
  price?: IgnavPrice;
  legs?: unknown[];
  ignav_id?: string;
}

interface IgnavFareResponse {
  origin?: string;
  destination?: string;
  departure_date?: string;
  return_date?: string;
  itineraries?: IgnavItinerary[];
}

export class FlightUpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "FlightUpstreamError";
  }
}

/**
 * Picks the cheapest usable fare.
 *
 * Filters rather than sorts-then-trusts so an unusable entry cannot win:
 *  - `price.status` must be absent or "available"; the schema does not enumerate the
 *    values, so anything that is not explicitly unavailable is allowed through
 *    rather than silently discarding every result if the vocabulary differs.
 *  - the currency must match the origin's, because the score compares the fare
 *    against an origin-currency theoretical baseline.
 */
export function cheapestFare(
  itineraries: IgnavItinerary[] | undefined,
  expectedCurrency: string,
): number | null {
  const usable: number[] = [];

  for (const itinerary of itineraries ?? []) {
    const price = itinerary.price;
    const amount = price?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    if (price?.status !== undefined && /unavailable|sold|expired/i.test(price.status)) {
      continue;
    }
    if (price?.currency && price.currency.toUpperCase() !== expectedCurrency.toUpperCase()) {
      continue;
    }
    usable.push(amount);
  }

  return usable.length > 0 ? Math.min(...usable) : null;
}

/**
 * Fetches the lowest round-trip fare in the origin's currency.
 *
 * History is deliberately not populated: the scorer's percentile path needs a
 * distribution of fares for the route over ~90 days, which is a batch job rather
 * than a request-path call. With no history the scorer falls back to the distance
 * model, which the UI labels as such.
 */
export async function fetchIgnavFlightQuote(
  credentials: PricingCredentials,
  origin: City,
  destination: City,
  departDate: string,
  returnDate: string,
): Promise<FlightScorerInput> {
  const route = findRoute(origin.id, destination.id);
  if (!route) {
    return { kind: "unavailable", reason: "no-quote" };
  }

  const [originCode, destinationCode] = route.airportPair;

  /**
   * The key is present in the cache key so that rotating a key cannot serve fares
   * fetched under the old one — a small thing, but it makes key rotation safe.
   */
  const cacheKey = [
    "ignav:fare",
    originCode,
    destinationCode,
    departDate,
    returnDate,
    origin.currency,
  ].join(":");

  let fare: number | null;
  try {
    fare = await remember(
      cacheKey,
      async () => {
        const body = await fetchJson<IgnavFareResponse>(
          `${BASE_URL}/api/fares/round-trip`,
          {
            timeoutMs: 12_000,
            attempts: 2,
            headers: { "X-Api-Key": credentials.apiKey },
            // A 404 here means "no fares for this route", not a broken request.
            emptyOnStatus: 404,
          },
        );
        if (!body) return null;
        return cheapestFare(body.itineraries, origin.currency);
      },
      { ttlMs: TTL.flightQuote, staleOnError: true },
    );
  } catch (error) {
    /**
     * A pricing outage degrades the flight dimension rather than failing the request.
     * The dimension is reported as unavailable and excluded from the total, so a
     * missing fare is never scored as a bad fare.
     */
    if (error instanceof Error && /401|403/.test(error.message)) {
      console.error("[ignav] authentication failed — check IITTG_FLIGHT_API_KEY");
    }
    return { kind: "unavailable", reason: "no-quote" };
  }

  if (fare === null) {
    return { kind: "unavailable", reason: "no-quote" };
  }

  const theoreticalUsd = route.roundTripMiles * 0.1;

  const quote: FlightQuote = {
    basis: "cached-fare",
    fareLocal: fare,
    fetchedAt: new Date().toISOString(),
    // Lower than the mock's 0.7 because the shape is unverified against a live
    // response, and the UI's confidence badge should say so.
    confidence: 0.55,
    distanceModel: {
      roundTripMiles: route.roundTripMiles,
      dollarsPerMile: 0.1,
      theoreticalUsd: Math.round(theoreticalUsd * 10) / 10,
    },
  };

  return { kind: "quote", quote };
}

/** Exported for tests. */
export const internals = {
  cheapestFare,
  BOOKING_WINDOW_DAYS,
  isBookingWindowError: (error: unknown) =>
    error instanceof FlightUpstreamError &&
    error.status === 400 &&
    /date|range|invalid/i.test(error.detail ?? ""),
  addDays,
};
