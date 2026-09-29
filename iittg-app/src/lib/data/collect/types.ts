/**
 * Collection-side types.
 *
 * The read side (`../hotel-price.ts`) answers "what is a night in this city
 * worth"; this side answers "go and find out". They are separate modules on
 * purpose: collection must never run on a request path, and keeping it in a
 * different directory is what makes that structurally true rather than merely
 * intended.
 *
 * ## The one rule this module exists to enforce
 *
 * A collector must be able to say **"I could not get this, and here is why"**.
 * Every fetch returns a `CollectOutcome` that is either rates or a *named*
 * failure — blocked by bot management, disallowed by robots.txt, no public
 * endpoint, unparseable. There is no path in this module that turns a failure
 * into a number, because a fabricated price is worse than a missing one: it
 * would move the hotel score and the user would have no way to tell.
 */

import type { City } from "../../scoring/types";
import type { HotelPriceBasis } from "../hotel-dataset";

export type { HotelPriceBasis };

/* ------------------------------------------------------------- properties */

/**
 * One property in a city's census.
 *
 * A census, not a basket: the reference price is the median over *all* hotels
 * this app has prices for, so membership is expected to grow. What must stay
 * stable is the identity of a property (`id`), otherwise two samples could be
 * mistaken for two hotels.
 */
export interface HotelPropertyRef {
  /** Globally unique and stable: `<source>:<source code>`. */
  id: string;
  cityId: string;
  name: string;
  /** The collector that produced it, e.g. `hotelbeds`. Free-form. */
  group: string;
  /** Star rating where the source states one; absent is not zero. */
  starRating?: number;
}

/**
 * The rate question, held constant across every property and date in a dataset.
 *
 * A median is only meaningful if every sample answers the same question — a
 * single room and a twin in the same hotel differ by 30-60% — so the basis lives
 * on the dataset (`HotelPriceBasis` in `../hotel-dataset.ts`) and the collector is
 * simply obliged to ask it.
 */

/* ------------------------------------------------------------------- rates */

/** A price as returned by a source, before it becomes a dataset sample. */
export interface RawRate {
  propertyId: string;
  cityId: string;
  /** Check-in date, ISO. One night per sample keeps the unit unambiguous. */
  date: string;
  priceLocal: number;
  currency: string;
  /** Which collector produced this, for auditability of mixed datasets. */
  source: string;
  collectedAt: string;
  /**
   * How much the collector trusts its own extraction. `verified` means the
   * source's shape is known and tested; `inferred` means a defensive field
   * search found the amount and the caller should review it.
   */
  extraction: "verified" | "inferred";
  /** Free-form audit trail (matched JSON path, room name, URL, ...). */
  note?: string;
}

/* ---------------------------------------------------------------- failures */

/**
 * Why a collection attempt produced nothing.
 *
 * Named rather than thrown, because "the site blocked us" and "the site has no
 * such endpoint" call for different responses from the operator: the first is a
 * reason to stop and reconsider the source, the second to fix the adapter.
 */
export type CollectFailure =
  /** Bot management answered instead of the site. */
  | { kind: "blocked"; by: string; evidence: string }
  /** robots.txt forbids this path for our user agent. */
  | { kind: "robots-disallowed"; rule: string; path: string }
  /** The group exposes no public endpoint this app can use. */
  | { kind: "no-endpoint"; detail: string }
  | { kind: "http-error"; status: number; detail: string }
  /** Reached the source, but no amount could be extracted. */
  | { kind: "parse-error"; detail: string }
  /**
   * The adapter is real but could not be verified end to end, because access is
   * blocked. It refuses to guess rather than emit an amount it cannot stand
   * behind.
   */
  | { kind: "unverified-shape"; detail: string }
  /** Deliberately not attempted (missing session, disabled by config, ...). */
  | { kind: "skipped"; reason: string };

export type CollectOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; failure: CollectFailure };

/** Convenience constructors, so adapters read as prose. */
export function collected<T>(data: T): CollectOutcome<T> {
  return { ok: true, data };
}

export function failed<T>(failure: CollectFailure): CollectOutcome<T> {
  return { ok: false, failure };
}

/* -------------------------------------------------------------- transport */

export interface FetchResponse {
  status: number;
  url: string;
  contentType: string;
  headers: Record<string, string>;
  body: string;
}

export interface FetchRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Milliseconds; the transport also holds its own ceiling. */
  timeoutMs?: number;
}

export type FetchFn = (request: FetchRequest) => Promise<FetchResponse>;

/**
 * A browser session handed to an adapter.
 *
 * Some sources answer only a request that carries the cookies a real visit
 * established. Rather than have the collector forge one — which is the part of
 * scraping that is both technically fragile and legally hostile — the session is
 * supplied by the operator and passed through verbatim.
 */
export interface BrowserSession {
  cookies: string;
  headers?: Record<string, string>;
}

/* --------------------------------------------------------- source identity */

/**
 * What the collector needs to know about a source to describe it in a report.
 *
 * Deliberately small. Earlier versions of this module carried a per-group
 * "crawlability" verdict — bot-management product, the robots.txt rule that settled
 * it, whether an official API exists — because the collection strategy was still
 * being decided by comparing chains. That comparison is settled: prices come from
 * Hotelbeds, and the surviving question is what each configured source *is*, not how
 * hospitably some other site treated a probe.
 */
export interface SourceInfo {
  /** Slug used in logs and in the run report, e.g. `hotelbeds`. */
  name: string;
  /** Human-readable name for the same place. */
  label: string;
}

/* --------------------------------------------------------------- adapters */

export interface CollectorContext {
  fetchFn: FetchFn;
  /** Path allow/deny answers from the site's own robots.txt, cached per host. */
  robots: RobotsGate;
  /** Supplied only when the operator has one; never obtained by this app. */
  session?: BrowserSession;
  now: Date;
  log: (message: string) => void;
  /** How many requests the transport has issued, for the run report. */
  requestsMade?: () => number;
}

export interface RobotsGate {
  /**
   * `allowed: false` carries the rule that forbade it, so the failure the user
   * sees quotes the site's own policy rather than a generic refusal.
   */
  check(url: string): Promise<{ allowed: true } | { allowed: false; rule: string }>;
}

/**
 * One question for a price source: "what does a night in this city cost on this date".
 *
 * The property is *optional* because sources differ in how they are asked. An
 * aggregator is asked once per city and answers with many hotels — it needs no
 * property list to exist first — while a source configured against named properties
 * (`--source`) cannot answer without one. Making the property optional is what lets a
 * city-wide source work in a city where nothing has been enumerated.
 */
export interface RateQuery {
  cityId: string;
  /** Check-in date, ISO. One night. */
  date: string;
  property?: HotelPropertyRef;
}

export interface CollectorAdapter {
  readonly name: string;
  readonly label: string;
  /**
   * Whether this source's amounts include taxes and fees.
   *
   * Declared per source because the dataset states one basis for every sample, and
   * the honest default is not "yes": a wholesale net rate's tax treatment varies by
   * hotel, and a source that does not say cannot be read as including them.
   */
  readonly taxIncluded?: boolean;

  /**
   * What may be published from this source: the concrete amount, or only how far it
   * sits from the ¥500 anchor.
   *
   * A wholesale net rate is not a retail price, and the agreement behind it governs
   * what may be shown. Sources therefore declare their safe default, and an operator
   * whose terms allow more passes `--disclosure price`.
   */
  readonly defaultDisclosure?: "price" | "index";
  /**
   * The city's full property list, where the group publishes one. Used to
   * measure coverage — "we have prices for 34 of 371 properties" — which is
   * what keeps a median honest about how much of the city it actually saw.
   */
  listProperties?(
    city: City,
    ctx: CollectorContext,
  ): Promise<CollectOutcome<HotelPropertyRef[]>>;

  /** Nightly prices for the requested city/date pairs. */
  fetchRates?(
    queries: RateQuery[],
    ctx: CollectorContext,
  ): Promise<CollectOutcome<RawRate[]>>;
}
