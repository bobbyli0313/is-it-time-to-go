/**
 * Tests for the shared HTTP client.
 *
 * These cover three failure modes that plain `fetch` does not handle and that were
 * all hit in practice against real upstreams. The most important is the first: an
 * upstream advertising unroutable IPv6 addresses made Node's fetch hang for its full
 * 10-second connect timeout and then fail, while `curl` worked fine because it
 * prefers IPv4. Measured before the fix: 10.5s hard failure. After: ~1.8s success.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, HttpError, internals, isRequestError } from "@/lib/data/http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson retry behaviour", () => {
  it("retries a transport failure and succeeds on a later attempt", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      // First attempt fails the way an unroutable IPv6 connect does.
      if (calls < 2) {
        const error = new TypeError("fetch failed");
        (error as { cause?: unknown }).cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
        throw error;
      }
      return Response.json({ ok: true });
    });

    const result = await fetchJson<{ ok: boolean }>("https://example.test/x", {
      backoffMs: 1,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("gives up after the configured number of attempts", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });

    await expect(
      fetchJson("https://example.test/x", { attempts: 3, backoffMs: 1 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(3);
  });

  it("retries a 5xx but not a 4xx", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return new Response("boom", { status: 503 });
    });
    await expect(
      fetchJson("https://example.test/x", { attempts: 2, backoffMs: 1 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(attempts).toBe(2);

    attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return new Response("nope", { status: 400 });
    });
    await expect(
      fetchJson("https://example.test/x", { attempts: 3, backoffMs: 1 }),
    ).rejects.toBeInstanceOf(HttpError);
    // A 4xx is a request problem; retrying it would only waste quota.
    expect(attempts).toBe(1);
  });

  it("treats the configured status as empty rather than an error", async () => {
    vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404 }));
    const result = await fetchJson("https://example.test/x", {
      emptyOnStatus: 404,
    });
    expect(result).toBeNull();
  });

  it("times out an attempt that never settles", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      // Never resolves; only the abort signal ends it.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });

    const started = Date.now();
    await expect(
      fetchJson("https://example.test/x", {
        timeoutMs: 60,
        attempts: 1,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    // Bounded, not indefinite.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("includes the status and a truncated detail on failure", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(500), { status: 500 }));
    await fetchJson("https://example.test/x", { attempts: 1 }).catch(
      (error: HttpError) => {
        expect(error.status).toBe(500);
        expect(error.detail?.length).toBeLessThanOrEqual(300);
      },
    );
  });

  it("sends a descriptive user agent", async () => {
    let seen: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return Response.json({});
    });
    await fetchJson("https://example.test/x");
    expect(seen["user-agent"]).toContain("iittg");
  });

  it("classifies retryable failures correctly", () => {
    const { isRetryable } = internals;
    // Server-side statuses are worth another attempt.
    expect(isRetryable(new HttpError("HTTP 503", 503))).toBe(true);
    // Client-side ones are not.
    expect(isRetryable(new HttpError("HTTP 400", 400))).toBe(false);

    const connectTimeout = new TypeError("fetch failed");
    (connectTimeout as { cause?: unknown }).cause = {
      code: "UND_ERR_CONNECT_TIMEOUT",
    };
    expect(isRetryable(connectTimeout)).toBe(true);

    expect(isRetryable(new Error("something else entirely"))).toBe(false);
  });
});

describe("request method and body", () => {
  it("defaults to GET with no body", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen = init;
      return Response.json({});
    });
    await fetchJson("https://example.test/x");
    expect(seen?.method).toBe("GET");
    expect(seen?.body).toBeUndefined();
  });

  /**
   * The bug this guards: Ignav's fare search is POST-only, and calling it with the
   * client's GET default returned a 405 that the adapter logged and swallowed as
   * "unavailable" — so live flight pricing was silently dead rather than visibly broken.
   */
  it("sends a JSON body with the right header when one is given", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen = init;
      return Response.json({});
    });
    await fetchJson("https://example.test/x", {
      method: "POST",
      body: { origin: "PVG", market: "CN" },
    });

    expect(seen?.method).toBe("POST");
    expect(JSON.parse(String(seen?.body))).toEqual({
      origin: "PVG",
      market: "CN",
    });
    const headers = seen?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });
});

describe("isRequestError", () => {
  it("classifies 4xx as a caller mistake", () => {
    // Retrying a malformed request wastes quota and hides the bug.
    expect(isRequestError(new HttpError("HTTP 405", 405))).toBe(true);
    expect(isRequestError(new HttpError("HTTP 400", 400))).toBe(true);
    expect(isRequestError(new HttpError("HTTP 401", 401))).toBe(true);
  });

  it("does not classify 5xx or transport failures as caller mistakes", () => {
    expect(isRequestError(new HttpError("HTTP 503", 503))).toBe(false);
    expect(isRequestError(new TypeError("fetch failed"))).toBe(false);
    expect(isRequestError(null)).toBe(false);
  });
});
