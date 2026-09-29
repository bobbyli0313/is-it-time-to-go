/**
 * The transport every adapter uses.
 *
 * Three jobs, all of them about being a visitor a site would not be wrong to
 * allow:
 *
 *  1. **Identify ourselves.** A named User-Agent with a contact string. This is
 *     not decoration: a site that blocks an anonymous client should be able to
 *     see who is asking, and the operator gets a real answer instead of a
 *     mystery 403.
 *  2. **Stay slow.** One request per host per interval, never concurrent to the
 *     same host, honouring `Crawl-delay` when the site publishes one, and a hard
 *     request budget per run so a mistyped date range cannot turn into a crawl.
 *  3. **Recognise a refusal.** Bot management answers with a 200 and a challenge,
 *     or a 403 with an HTML body from an edge network. `detectBotWall` names the
 *     product so the failure the operator reads says "Akamai blocked this",
 *     not "unexpected status 403".
 */

import type { CollectFailure, FetchFn, FetchRequest, FetchResponse } from "./types";

/**
 * The collector's identity. `crawlDelayMs` and robots.txt are both keyed off the
 * product token (`IITTG-hotel-collector`), so this string is part of the
 * contract with the sites being read, not a cosmetic default.
 */
export const USER_AGENT =
  "IITTG-hotel-collector/0.1 (+https://github.com/iittg; travel price research)";

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Minimum spacing between two requests to the same host. */
export const DEFAULT_MIN_INTERVAL_MS = 3_000;

/**
 * Ceiling on requests for a single collection run.
 *
 * The reference price is a median over a city's hotels, so a full run is
 * cities × properties × dates and grows quickly. A budget makes the cost of a
 * run explicit and stops a bad argument from becoming a load test.
 */
export const DEFAULT_MAX_REQUESTS = 400;

/**
 * Raised by the transport when a run would exceed its stated budget.
 *
 * Written without a TypeScript parameter property on purpose: the collector CLI
 * runs `.ts` directly on Node, whose type support is *strip-only* and rejects that
 * syntax. See `scripts/ts-loader.mjs`.
 */
export class BudgetExhaustedError extends Error {
  readonly budget: number;

  constructor(budget: number) {
    super(`Request budget of ${budget} exhausted for this run.`);
    this.name = "BudgetExhaustedError";
    this.budget = budget;
  }
}

/* -------------------------------------------------------- bot management */

/** Fingerprints of the products that answered while this app was probing. */
const WALLS: Array<{ name: string; test: RegExp }> = [
  { name: "Akamai", test: /akamai|_abck|ak_bmsc|edgesuite\.net|reference #/i },
  { name: "Cloudflare", test: /cf-ray|cloudflare/i },
  { name: "PerimeterX/HUMAN", test: /perimeterx|_px|px-captcha/i },
  { name: "DataDome", test: /datadome/i },
  { name: "Imperva/Incapsula", test: /incap_ses|visid_incap|imperva/i },
  { name: "Kasada", test: /kasada|x-kpsdk|window\.KPSDK/i },
  { name: "F5/Shape", test: /x-wa-info|shapesecurity/i },
];

/**
 * Names the bot-management product behind a response, if any.
 *
 * Deliberately generous: browser challenges are served with status 200 and a
 * normal content type, so a status check alone would treat `window.KPSDK` as a
 * successful page load. Checking the body is what stops the collector from
 * "parsing" a challenge page and reporting zero rates.
 */
export function detectBotWall(response: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): string | null {
  const haystack = [
    ...Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`),
    response.body.slice(0, 4_000),
  ].join("\n");

  for (const wall of WALLS) {
    if (wall.test.test(haystack)) return wall.name;
  }

  if (response.status === 429) return "rate limit (HTTP 429)";
  return null;
}

/** Turns a refused response into the named failure the operator reads. */
export function refusalOf(response: FetchResponse): CollectFailure | null {
  const wall = detectBotWall(response);
  if (wall) {
    return {
      kind: "blocked",
      by: wall,
      evidence: `HTTP ${response.status} from ${response.url}`,
    };
  }
  if (response.status >= 400) {
    return {
      kind: "http-error",
      status: response.status,
      detail: `HTTP ${response.status} from ${response.url}`,
    };
  }
  return null;
}

/* ------------------------------------------------------------ transport */

export interface PoliteFetchOptions {
  /** Injectable for tests; defaults to global `fetch`. */
  underlying?: typeof globalThis.fetch;
  userAgent?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRequests?: number;
  /** Per-host spacing override, e.g. a site's published `Crawl-delay`. */
  crawlDelayMs?: number;
  log?: (message: string) => void;
}

export interface RequestLogEntry {
  url: string;
  status: number | null;
  ms: number;
  at: string;
}

export interface PoliteFetch {
  fetchFn: FetchFn;
  /** Every request made, for the run report the CLI prints. */
  log: RequestLogEntry[];
  requestsMade(): number;
}

/**
 * Builds the rate-limited fetch the adapters share.
 *
 * The limiter is per host and serialises requests to the same host rather than
 * merely spacing them: a burst of parallel requests to one origin is exactly the
 * pattern bot management exists to stop, and it is also the pattern that gets an
 * operator's IP blocked.
 */
export function createPoliteFetch(options: PoliteFetchOptions = {}): PoliteFetch {
  const underlying = options.underlying ?? globalThis.fetch;
  const userAgent = options.userAgent ?? USER_AGENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const minIntervalMs = Math.max(
    options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    options.crawlDelayMs ?? 0,
  );
  const log = options.log ?? (() => {});
  const entries: RequestLogEntry[] = [];

  /** Per-host promise chain: the next request waits for the previous one. */
  const hostChains = new Map<string, Promise<unknown>>();
  const lastRequestAt = new Map<string, number>();
  let count = 0;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const fetchFn: FetchFn = async (request: FetchRequest) => {
    if (count >= maxRequests) throw new BudgetExhaustedError(maxRequests);

    const host = new URL(request.url).host;
    const previous = hostChains.get(host) ?? Promise.resolve();

    const run = previous.then(async () => {
      if (count >= maxRequests) throw new BudgetExhaustedError(maxRequests);

      const since = Date.now() - (lastRequestAt.get(host) ?? 0);
      if (since < minIntervalMs) await sleep(minIntervalMs - since);

      count += 1;
      lastRequestAt.set(host, Date.now());

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        request.timeoutMs ?? timeoutMs,
      );
      const started = Date.now();

      try {
        const response = await underlying(request.url, {
          method: request.method ?? "GET",
          headers: {
            "User-Agent": userAgent,
            Accept: "application/json, text/html;q=0.9, */*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            ...(request.headers ?? {}),
          },
          body: request.body,
          redirect: "follow",
          signal: controller.signal,
        });

        const body = await response.text();
        const headers = Object.fromEntries(response.headers.entries());
        const result: FetchResponse = {
          status: response.status,
          url: response.url || request.url,
          contentType: headers["content-type"] ?? "",
          headers,
          body,
        };

        entries.push({
          url: request.url,
          status: response.status,
          ms: Date.now() - started,
          at: new Date().toISOString(),
        });
        log(`  → ${response.status} ${request.url}`);

        return result;
      } catch (error) {
        entries.push({
          url: request.url,
          status: null,
          ms: Date.now() - started,
          at: new Date().toISOString(),
        });
        log(`  → ERR ${request.url} (${String(error)})`);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });

    // Keep the chain alive even when this request rejects, so one failure does
    // not stall every later request to the same host.
    hostChains.set(
      host,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );

    return run;
  };

  return { fetchFn, log: entries, requestsMade: () => count };
}
