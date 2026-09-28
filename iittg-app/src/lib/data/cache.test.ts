/**
 * Tests for the TTL cache.
 *
 * The disk layer is exercised against a real temporary directory rather than being
 * skipped. It was previously untested: the suite disabled disk writes via
 * `IITTG_CACHE_DISK=0`, and an environment variable cannot be overridden from inside
 * a test once vitest has injected `test.env`. Making the directory injectable is what
 * closed that gap.
 *
 * The disk layer matters more than it looks: it is what stops a dev-server restart
 * from re-paying for Open-Meteo's archive endpoint (7-10 seconds per call), and what
 * lets a long-lived scorer process keep a warm cache across a deploy.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TTL,
  cacheDir,
  cacheGet,
  cacheSet,
  clearMemoryCache,
  remember,
} from "@/lib/data/cache";

let dir: string;

beforeEach(async () => {
  clearMemoryCache();
  dir = await mkdtemp(join(tmpdir(), "iittg-cache-test-"));
});

afterEach(async () => {
  clearMemoryCache();
  await rm(dir, { recursive: true, force: true });
});

describe("memory layer", () => {
  it("returns a fresh value and not an expired one", async () => {
    await cacheSet("k1", { v: 1 }, 60_000, Date.now(), dir);
    expect((await cacheGet<{ v: number }>("k1", Date.now(), dir))?.value).toEqual({
      v: 1,
    });

    // Write an already-expired entry directly, then confirm it is not served.
    await cacheSet("k2", { v: 2 }, -1, Date.now(), dir);
    expect(await cacheGet("k2", Date.now(), dir)).toBeNull();
  });

  it("records when a value was stored, for the freshness badge", async () => {
    const before = Date.now();
    const entry = await cacheSet("k3", "x", 60_000, before, dir);
    expect(entry.storedAt).toBe(before);
    expect(entry.expiresAt).toBe(before + 60_000);
  });
});

describe("disk layer", () => {
  it("survives clearing memory, which is what a restart looks like", async () => {
    await cacheSet("persist", { hello: "disk" }, 60_000, Date.now(), dir);
    const files = await readdir(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);

    // Drop all in-process state; only the file remains.
    clearMemoryCache();
    const rehydrated = await cacheGet<{ hello: string }>(
      "persist",
      Date.now(),
      dir,
    );
    expect(rehydrated?.value).toEqual({ hello: "disk" });
  });

  it("does not serve an expired entry from disk either", async () => {
    await cacheSet("stale", "old", -1, Date.now(), dir);
    clearMemoryCache();
    expect(await cacheGet("stale", Date.now(), dir)).toBeNull();
  });

  it("hashes keys, so an arbitrary key cannot escape the directory", async () => {
    const nasty = "../../etc/passwd";
    await cacheSet(nasty, "safe", 60_000, Date.now(), dir);
    const files = await readdir(dir);
    expect(files.length).toBe(1);
    expect(files[0]).not.toContain("..");
    expect(files[0]).not.toContain("passwd");

    clearMemoryCache();
    expect((await cacheGet(nasty, Date.now(), dir))?.value).toBe("safe");
  });

  it("misses cleanly rather than throwing on an unreadable directory", async () => {
    const missing = join(dir, "does", "not", "exist");
    // The directory is created on demand, so this is a miss, not an error.
    expect(await cacheGet("nope", Date.now(), missing)).toBeNull();
  });
});

describe("single-flight", () => {
  /**
   * Without this, N concurrent requests for the same cold key produce N upstream
   * calls — exactly the stampede that exhausts a free tier.
   */
  it("collapses concurrent loads of the same key into one call", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return new Promise<string>((resolve) =>
        setTimeout(() => resolve("value"), 20),
      );
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        remember("same-key", load, { ttlMs: 60_000, dir }),
      ),
    );

    expect(results).toEqual(Array(8).fill("value"));
    expect(calls).toBe(1);
  });

  it("does not collapse different keys", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls;
    };
    await Promise.all([
      remember("a", load, { ttlMs: 60_000, dir }),
      remember("b", load, { ttlMs: 60_000, dir }),
      remember("c", load, { ttlMs: 60_000, dir }),
    ]);
    expect(calls).toBe(3);
  });

  it("releases the in-flight slot so a later call can retry", async () => {
    await expect(
      remember("boom", async () => {
        throw new Error("upstream down");
      }, { ttlMs: 60_000, dir }),
    ).rejects.toThrow("upstream down");

    // A failed load must not leave the key permanently wedged.
    const ok = await remember("boom", async () => "recovered", {
      ttlMs: 60_000,
      dir,
    });
    expect(ok).toBe("recovered");
  });
});

describe("stale-on-error", () => {
  /**
   * The behaviour that keeps a climate normal available when the archive endpoint is
   * flaky: a week-old answer is far better than a failed request for data that
   * changes on the scale of decades.
   */
  it("serves an expired value when the loader fails", async () => {
    await cacheSet("climate", { tempC: 21 }, -1, Date.now(), dir);
    clearMemoryCache();

    const value = await remember(
      "climate",
      async () => {
        throw new Error("archive unavailable");
      },
      { ttlMs: 60_000, staleOnError: true, dir },
    );

    expect(value).toEqual({ tempC: 21 });
  });

  it("rethrows when there is nothing stale to fall back on", async () => {
    await expect(
      remember(
        "nothing-cached",
        async () => {
          throw new Error("archive unavailable");
        },
        { ttlMs: 60_000, staleOnError: true, dir },
      ),
    ).rejects.toThrow("archive unavailable");
  });

  it("rethrows when stale fallback was not requested", async () => {
    await cacheSet("fresh-enough", "old", -1, Date.now(), dir);
    clearMemoryCache();
    await expect(
      remember(
        "fresh-enough",
        async () => {
          throw new Error("nope");
        },
        { ttlMs: 60_000, dir },
      ),
    ).rejects.toThrow("nope");
  });
});

describe("configuration", () => {
  it("resolves the cache directory lazily, not at import time", () => {
    // If this were captured at module load, a test could not redirect it.
    const before = cacheDir();
    process.env.IITTG_CACHE_DIR = "/tmp/iittg-lazy-check";
    try {
      expect(cacheDir()).toBe("/tmp/iittg-lazy-check");
    } finally {
      delete process.env.IITTG_CACHE_DIR;
    }
    expect(cacheDir()).toBe(before);
  });

  it("exposes TTLs ordered sensibly for their sources", () => {
    // Forecasts move fast; climate normals do not. A regression that swapped these
    // would either hammer the archive or serve stale forecasts.
    expect(TTL.forecast).toBeLessThan(TTL.fxLatest);
    expect(TTL.fxLatest).toBeLessThan(TTL.climateNormal);
    expect(TTL.flightQuote).toBeGreaterThan(0);
  });
});
