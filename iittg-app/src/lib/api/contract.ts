/**
 * The wire contract between the browser and the scoring route.
 *
 * Shared by both sides so they cannot drift: the route handler validates against
 * these shapes and the client renders them. Kept free of any Node-only import so it
 * is safe to pull into a client component.
 */

import type { ScoreResult } from "../scoring/types";
import type { DataProvenance } from "../data/types";

/**
 * What the browser sends.
 *
 * IATA codes rather than internal city ids, because that is what the user typed and
 * what the API should be able to answer for: `"PVG"`, `"HND"`, `"LHR"`. A code the app
 * does not know is rejected with `form.cityUnsupported` — never resolved to a nearest
 * match, which is how someone ends up looking at a trip to the wrong continent.
 */
export type ScoreRequest = {
  /** IATA airport code (PVG) or city code (SHA, TYO, LON). Case-insensitive. */
  originCode: string;
  destinationCode: string;
  /** Inclusive departure date, `YYYY-MM-DD`. */
  departDate: string;
  /** Inclusive return date, `YYYY-MM-DD`. */
  returnDate: string;
  travellers?: number;
};

export type ScoreTripSummary = {
  originName: { en: string; zh: string };
  destinationName: { en: string; zh: string };
  departDate: string;
  returnDate: string;
  originCurrency: string;
  destinationCurrency: string;
  airportPair: [string, string];
};

export type ScoreResponse =
  | {
      ok: true;
      result: ScoreResult;
      trip: ScoreTripSummary;
      /** Where each dimension's data actually came from. Disclosed, never inferred. */
      provenance: DataProvenance;
      /** Non-fatal data-quality notes the UI must show rather than hide. */
      dataNotes: string[];
    }
  | {
      ok: false;
      /** An i18n key, so the message localises. */
      error: string;
    };

/** Field limits the route enforces, mirrored by the form for immediate feedback. */
export const LIMITS = {
  /** The spec's departure window. */
  minLeadDays: 0,
  maxLeadDays: 30,
  minTripDays: 1,
  maxTripDays: 30,
} as const;
