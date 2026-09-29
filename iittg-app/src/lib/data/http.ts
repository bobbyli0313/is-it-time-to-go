/**
 * Shared HTTP client for upstream data sources.
 *
 * ## Why a hand-rolled helper rather than plain `fetch`
 *
 * Three problems came up in practice that plain `fetch` does not solve:
 *
 * 1. **Unroutable IPv6.** `date.nager.at` advertises AAAA records, and Node's
 *    fetch prefers IPv6, which on this network blackholes until the 10-second
 *    connect timeout fires. `curl` was fine throughout because it prefers IPv4.
 *    Measured: 10.5s failure with the default order, 1.8s success with IPv4 first.
 *    Per-attempt timeouts plus a retry that prefers IPv4 turns a hard failure into
 *    a slow success, and the result is then cached for a week.
 *
 * 2. **No timeout by default.** A hung upstream would otherwise hold a request
 *    open indefinitely. Every attempt here is bounded.
 *
 * 3. **Transient 5xx.** Free public APIs hiccup. A single retry with a short
 *    backoff absorbs most of it.
 *
 * Retries are deliberately limited to *transport* failures and 5xx. A 4xx is a
 * request problem and retrying it would just waste quota.
 */

import dns from "node:dns";

/**
 * Prefer IPv4 process-wide.
 *
 * The alternative — passing `family: 4` per request — is not reliably supported by
 * undici's fetch options, and this is a property of the network rather than of any
 * particular upstream. Done once at module load so the first request benefits too.
 */
dns.setDefaultResultOrder("ipv4first");

export interface HttpJsonOptions {
  /** Milliseconds allowed per attempt. */
  timeoutMs?: number;
  /** Total attempts, including the first. */
  attempts?: number;
  /** Base backoff between attempts; grows linearly. */
  backoffMs?: number;
  /** Identifies this app, as most public APIs ask. */
  userAgent?: string;
  /** Extra headers, e.g. an Authorization token. */
  headers?: Record<string, string>;
  /**
   * Treat this status as "no data" rather than an error. Nager.Date answers 404 for
   * a country/year it does not cover, which is a coverage gap, not a failure.
   */
  emptyOnStatus?: number;
  /** Defaults to GET. Ignav's fare search, for instance, is POST-only. */
  method?: "GET" | "POST";
  /** JSON body, sent with `content-type: application/json` when present. */
  body?: unknown;
}

export class HttpError extends Error {
  /**
   * Declared rather than written as parameter properties: the collector CLI
   * imports this module and runs it through Node's strip-only TypeScript support,
   * which rejects that syntax. See `scripts/ts-loader.mjs`.
   */
  readonly status?: number;
  readonly detail?: string;
  readonly attempts?: number;

  constructor(
    message: string,
    status?: number,
    detail?: string,
    attempts?: number,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
    this.attempts = attempts;
  }
}

const DEFAULT_USER_AGENT =
  "iittg-prototype/0.1 (+https://github.com/bobbyli0313/is-it-time-to-go)";

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

/** True for failures worth retrying: timeouts, socket errors, 5xx. */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    // Only server-side statuses are worth another attempt.
    return error.status !== undefined && error.status >= 500;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(
      `${error.message} ${errorCode(error)}`,
    );
  }
  return false;
}

/**
 * True for statuses that indicate the *request* is wrong — a bad method, a bad body,
 * a missing parameter. These are programming errors: retrying them wastes quota and,
 * worse, hides the mistake behind a generic failure. A 405 from a POST-only endpoint
 * called with GET is exactly this case, and it was found by an end-to-end run rather
 * than by a unit test.
 */
export function isRequestError(error: unknown): boolean {
  return error instanceof HttpError && error.status !== undefined && error.status >= 400 && error.status < 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches JSON with a per-attempt timeout and bounded retries.
 *
 * Throws `HttpError` when every attempt fails, so callers can decide whether a
 * missing source degrades a dimension or fails the request.
 */
export async function fetchJson<T>(
  url: string,
  options: HttpJsonOptions = {},
): Promise<T | null> {
  const {
    /**
     * 5s per attempt, not 10s+. Measured worst case with an unroutable-IPv6 host is
     * "one wasted attempt, then success", so a tighter bound cuts a cold-cache
     * request from ~26s to a few seconds without risking healthy upstreams —
     * the p99 for these endpoints is under 2s.
     */
    timeoutMs = 5_000,
    attempts = 3,
    backoffMs = 600,
    userAgent = DEFAULT_USER_AGENT,
    headers = {},
    emptyOnStatus,
    method = "GET",
    body,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // Our own TTL cache owns freshness; Next's fetch cache would add a second,
        // invisible policy layer.
        cache: "no-store",
      });

      if (emptyOnStatus !== undefined && response.status === emptyOnStatus) {
        return null;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new HttpError(
          `HTTP ${response.status}`,
          response.status,
          detail.slice(0, 300),
          attempt,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error);
      if (!retryable || attempt === attempts) break;
      // Linear backoff. The common case here is a 10s IPv6 blackhole, after which
      // the next attempt succeeds, so a short wait is enough.
      await sleep(backoffMs * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof HttpError) throw lastError;
  throw new HttpError(
    lastError instanceof Error ? lastError.message : "Request failed",
    undefined,
    errorCode(lastError),
    attempts,
  );
}

export const internals = { isRetryable, errorCode };
