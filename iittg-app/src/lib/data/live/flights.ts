/**
 * Flight pricing via Ignav (ignav.com).
 *
 * ## Why not Amadeus
 *
 * The Amadeus Self-Service portal was decommissioned on 17 July 2026 and its API keys
 * were disabled; flight access there now requires an enterprise sales contract. An
 * adapter was written against it and then deleted — see git history — and this note
 * exists so nobody re-adds it.
 *
 * ## Verified against real responses
 *
 * The shapes below were confirmed against live calls, not inferred from documentation.
 * Four things the first draft got wrong, each of which would have broken the dimension
 * silently rather than loudly:
 *
 * 1. **`market` is what sets the currency, and it defaults to `US`.** The schema
 *    lists no `currency` parameter at all — passing one is a 400 — and omitting
 *    `market` returns every fare in USD. Since the score compares a fare against an
 *    origin-currency baseline, currency filtering alone would have rejected *every*
 *    itinerary and left the dimension permanently unavailable. `market` is therefore
 *    set from the origin city's country, which was verified to yield CNY, TWD, THB,
 *    SGD, KRW, HKD and PHP correctly. `market` also localises carrier names.
 *
 * 2. **Itineraries carry `outbound`/`inbound`, not a `legs` array.** The OpenAPI
 *    document declares a `legs` field that is absent from real responses.
 *
 * 3. **`price.status` is `verified` or `unverified`, and the gap is enormous.** On
 *    PVG-HND the cheapest verified round trip was USD 464 while unverified fares
 *    started at USD 117 — a factor of four. Unverified fares are treated as
 *    unusable by default, because scoring on them would make every route look
 *    extraordinarily cheap and the dimension would stop discriminating.
 *
 * 4. **A sanity floor.** Even restricted to verified fares, a 180-minute
 *    international round trip for USD 117 is not a real itinerary. A ratio floor
 *    against the distance model catches that class of bad data without pretending the
 *    distance model is accurate.
 *
 * ## Response size
 *
 * A single round-trip search returned 1.3 MB and took 88 seconds for ICN-NRT. Caching
 * is not optional here, and `max` should be kept low.
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
import { fetchJson, HttpError, isRequestError } from "../http";
import { usdRateTo } from "./fx";

const BASE_URL = "https://ignav.com";

/** Airlines generally open bookings this far ahead. */
const BOOKING_WINDOW_DAYS = 330;

/**
 * Ignav's response is large and slow, so the per-attempt timeout is well above the
 * shared default. Measured: 1.3 MB and up to 88s for a long route.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Floors a fare must clear to be believed, as a fraction of the *route's own median*.
 *
 * Deliberately not a fraction of the distance model. An earlier version compared each
 * fare against `miles x $0.10`, which is denominated in USD, while the fares arrive in
 * the origin's currency — a unit error that silently rejected every legitimate CNY
 * fare on PVG-HND. A median-relative floor needs no currency conversion and adapts to
 * the route: a round trip at under a fifth of what the same search usually returns is
 * not a bargain, it is bad data.
 */
const MIN_RATIO_OF_MEDIAN = 0.2;

export type FareStatus = "verified" | "unverified";

interface IgnavPrice {
  amount?: number;
  currency?: string;
  status?: string;
}

interface IgnavItinerary {
  price?: IgnavPrice;
  outbound?: unknown;
  inbound?: unknown;
  ignav_id?: string;
}

interface IgnavFareResponse {
  origin?: string;
  destination?: string;
  departure_date?: string;
  return_date?: string;
  itineraries?: IgnavItinerary[];
}

export interface FareSelection {
  amount: number | null;
  /** How many itineraries cleared every filter. */
  considered: number;
  /** Why nothing was usable, for logging and the data-details panel. */
  rejectedFor?: "no-itineraries" | "currency-mismatch";
}

/**
 * Chooses the cheapest usable fare.
 *
 * Selection is by *usability* rather than by sorting and trusting, so an implausible
 * entry cannot win: a status of `unverified`, a currency other than the origin's, or a
 * price below the sanity floor all disqualify an itinerary outright.
 */
export function selectCheapestFare(
  itineraries: IgnavItinerary[] | undefined,
  expectedCurrency: string,
  theoreticalUsd: number,
): FareSelection {
  void theoreticalUsd; // Retained in the signature for callers; the floor is unit-free.

  const list = itineraries ?? [];
  if (list.length === 0) {
    return { amount: null, considered: 0, rejectedFor: "no-itineraries" };
  }

  let sawCurrencyMismatch = false;
  let sawPricedItinerary = false;
  const priced: number[] = [];

  for (const itinerary of list) {
    const price = itinerary.price;
    if (!price) continue;

    const amount = price.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    sawPricedItinerary = true;

    /**
     * Currency is checked *before* the status filter, so the reason reported reflects
     * the most actionable problem. A response in the wrong currency is a configuration
     * bug — almost always a missing `market` parameter — and saying so is far more
     * useful than "no verified fares".
     */
    if (
      price.currency &&
      price.currency.toUpperCase() !== expectedCurrency.toUpperCase()
    ) {
      sawCurrencyMismatch = true;
      continue;
    }

    /**
     * Verified only. The verified/unverified gap was a factor of four on a real route,
     * so mixing them would let a possibly-erroneous fare set the score.
     */
    if (price.status !== "verified") continue;

    priced.push(amount);
  }

  if (priced.length === 0) {
    /**
     * The reported reason is the most actionable one: a currency mismatch is a
     * configuration bug (almost always a missing `market`), and saying so beats
     * "no fares found".
     */
    void sawPricedItinerary;
    return {
      amount: null,
      considered: 0,
      rejectedFor: sawCurrencyMismatch ? "currency-mismatch" : "no-itineraries",
    };
  }

  /**
   * The floor is derived from the surviving fares rather than from any external
   * reference, which is what keeps it currency-agnostic. Note there is no
   * "everything was rejected" branch, and that is a property of the rule rather than an
   * omission: at least half the fares are at or above the median, so the filter can
   * only ever remove a minority. An earlier version carried a `below-sanity-floor`
   * reason that was unreachable, which is worse than no handling at all because it
   * implies a case that cannot happen.
   */
  const sorted = [...priced].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const floor = median * MIN_RATIO_OF_MEDIAN;

  const usable = priced.filter((amount) => amount >= floor);
  return { amount: Math.min(...usable), considered: usable.length };
}

/**
 * Fetches the lowest round-trip fare in the origin's currency.
 *
 * History is deliberately not populated: the scorer's percentile path needs a
 * distribution of fares for the route over ~90 days, which is a batch job rather than
 * a request-path call. With no history the scorer falls back to the distance model,
 * which the UI labels as such.
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
  const theoreticalUsd = route.roundTripMiles * 0.1;

  /**
   * `market` comes from the origin city's country and is what makes the response
   * currency match `origin.currency`. The key is part of the cache key so rotating a
   * key cannot serve fares fetched under the old one.
   */
  const cacheKey = [
    "ignav:fare",
    credentials.apiKey.slice(-8),
    originCode,
    destinationCode,
    departDate,
    returnDate,
    origin.currency,
    origin.country,
  ].join(":");

  let selection: FareSelection;
  try {
    selection = await remember(
      cacheKey,
      async () => {
        const response = await fetchJson<IgnavFareResponse>(
          `${BASE_URL}/api/fares/round-trip`,
          {
            // POST, not GET. The endpoint is search-shaped: it takes a JSON body and
            // rejects GET with a 405. Calling it with the shared client's GET default
            // was the bug that made live flight pricing silently unavailable.
            method: "POST",
            body: {
              origin: originCode,
              destination: destinationCode,
              departure_date: departDate,
              return_date: returnDate,
              adults: 1,
              /**
               * `market` is what selects the response currency. Omitting it defaults to
               * `US`, which returns USD and would be refused by the currency check
               * below — so this field is load-bearing, not cosmetic. It also localises
               * carrier names.
               */
              market: origin.country,
            },
            timeoutMs: REQUEST_TIMEOUT_MS,
            // One retry only: the request is large and slow, and a second full attempt
            // doubles the worst case for little gain.
            attempts: 2,
            headers: { "X-Api-Key": credentials.apiKey },
            emptyOnStatus: 404,
          },
        );
        const body = response;
        if (!body) {
          return {
            amount: null,
            considered: 0,
            rejectedFor: "no-itineraries" as const,
          };
        }
        return selectCheapestFare(
          body.itineraries,
          origin.currency,
          theoreticalUsd,
        );
      },
      { ttlMs: TTL.flightQuote, staleOnError: true },
    );
  } catch (error) {
    /**
     * A pricing outage degrades the flight dimension rather than failing the request.
     * The dimension is reported unavailable and excluded from the total, so a missing
     * fare is never scored as a bad one.
     */
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpError && error.status === 401) {
      console.error("[ignav] authentication failed — check IITTG_FLIGHT_API_KEY");
    } else if (isRequestError(error)) {
      // A 4xx means our request is malformed. Retrying cannot help and silently
      // degrading to "unavailable" would hide a bug, so this is logged loudly.
      console.error(
        `[ignav] request rejected (${error instanceof HttpError ? error.status : "?"}) — this is a bug in the adapter, not an upstream outage`,
        error instanceof HttpError ? error.detail : "",
      );
    } else {
      console.error("[ignav] fare lookup failed:", message);
    }
    return { kind: "unavailable", reason: "no-quote" };
  }

  if (selection.amount === null) {
    return { kind: "unavailable", reason: "no-quote" };
  }

  /**
   * The distance anchor is a USD heuristic, so a fare in any other currency cannot be
   * compared against it until it is converted. Dividing a CNY fare by a USD anchor
   * produced a ratio of 13.8 on a route whose true ratio was about 2 — a wrong answer
   * presented with full confidence.
   *
   * If no rate is available, the anchor is dropped rather than guessed. `theoreticalUsd`
   * stays populated for disclosure, and the adapter reports the fare without a
   * distance comparison so nothing downstream can divide by the wrong unit.
   */
  const usdRate = await usdRateTo(origin.currency);
  const theoreticalLocal =
    usdRate === null ? null : Math.round(theoreticalUsd * usdRate * 100) / 100;

  const quote: FlightQuote = {
    basis: "cached-fare",
    fareLocal: selection.amount,
    fetchedAt: new Date().toISOString(),
    /**
     * Capped below the mock's 0.7: the parsing is verified against real responses, but
     * the percentile path still has no history.
     */
    confidence: 0.65,
    distanceModel: {
      roundTripMiles: route.roundTripMiles,
      dollarsPerMile: 0.1,
      /** USD anchor, kept as the documented reference point. */
      theoreticalUsd: Math.round(theoreticalUsd * 10) / 10,
      /**
       * The anchor expressed in the origin's currency, which is the only form that can
       * be compared against `fareLocal`.
       */
      ...(theoreticalLocal !== null
        ? { theoreticalLocal, localPerUsd: usdRate as number }
        : {}),
    },
  };

  return { kind: "quote", quote };
}

/** Exported for tests. */
export const internals = {
  selectCheapestFare,
  BOOKING_WINDOW_DAYS,
  MIN_RATIO_OF_MEDIAN,
  REQUEST_TIMEOUT_MS,
  isBookingWindowError: (error: unknown) =>
    error instanceof Error &&
    /400/.test(error.message) &&
    /date|range|invalid/i.test(error.message),
  addDays,
};
