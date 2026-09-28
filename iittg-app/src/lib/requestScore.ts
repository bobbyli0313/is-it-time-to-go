/**
 * The one call the UI makes to get a score.
 *
 * This is a thin HTTP client over `/api/score`. Scoring itself lives server-side
 * (see the route handler) because it needs API keys, a process-wide cache, and
 * upstream calls that must not run in a visitor's browser.
 *
 * The signature is unchanged from the prototype version that computed everything
 * in-process, so no component needed touching when the move happened — which was
 * exactly what that single entry point was for.
 */

import type { ScoreRequest, ScoreResponse } from "./api/contract";

export type { ScoreRequest, ScoreResponse } from "./api/contract";

/** Client-side timeout. The route sets its own, shorter, per-upstream timeouts. */
const CLIENT_TIMEOUT_MS = 45_000;

export async function requestScore(
  request: ScoreRequest,
  /**
   * Retained for call-site compatibility with the in-process version, where the
   * clock had to be injected for deterministic tests. The server owns the clock now.
   */
  _now?: Date,
): Promise<ScoreResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  try {
    const response = await fetch("/api/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as
      | ScoreResponse
      | null;

    // The route answers with a localisable i18n key, so it is returned as-is rather
    // than turned into prose here.
    if (body) return body;

    return {
      ok: false,
      error: response.ok ? "error.invalidResponse" : "error.upstreamUnavailable",
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "error.timeout" };
    }
    return { ok: false, error: "error.network" };
  } finally {
    clearTimeout(timer);
  }
}
