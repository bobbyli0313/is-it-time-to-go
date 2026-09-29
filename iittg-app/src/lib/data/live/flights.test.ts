/**
 * Tests for the Ignav flight adapter.
 *
 * Two kinds of coverage, because they catch different things:
 *
 *  1. **Fixture tests** assert against verbatim recorded responses. The first version
 *     of this adapter was written from the OpenAPI document alone and was wrong in
 *     ways that would have failed *silently*: it looked for a `legs` array that real
 *     responses do not have, and its currency filter would have rejected every
 *     itinerary, leaving the dimension permanently "unavailable" rather than visibly
 *     broken. Fixtures turn those assumptions into assertions.
 *
 *  2. **Unit tests** pin the selection rules — verified-only, currency match, outlier
 *     floor — each of which is a decision that would otherwise be invisible in a score.
 *
 * Fixture provenance, and why there are two captures of the same route:
 *  - `ignav-pvg-hnd-cny.json` was recorded with `market=CN` and returns CNY.
 *  - `ignav-pvg-hnd-usd-default-market.json` was recorded with no `market` at all,
 *    which defaults to `US` and returns USD.
 * Keeping both is what makes the market/currency behaviour testable rather than
 * merely asserted, and it is the single most important thing this adapter has to get
 * right: the score compares a fare against an origin-currency baseline.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectCheapestFare, internals } from "@/lib/data/live/flights";

const fixtureDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

interface RecordedItinerary {
  price: { amount: number; currency: string; status: string };
  outbound?: unknown;
  inbound?: unknown;
  ignav_id?: string;
}

interface RecordedResponse {
  origin: string;
  destination: string;
  departure_date: string;
  return_date: string;
  itineraries: RecordedItinerary[];
}

function fixture(name: string): RecordedResponse {
  return JSON.parse(readFileSync(`${fixtureDir}${name}`, "utf8"));
}

const PVG_HND_CNY = "ignav-pvg-hnd-cny.json";
const PVG_HND_USD = "ignav-pvg-hnd-usd-default-market.json";
const ICN_NRT_KRW = "ignav-icn-nrt-roundtrip.json";

/** PVG-HND is ~1,100 miles each way, so the distance model gives about USD 220. */
const PVG_HND_THEORETICAL_USD = 219.8;

describe("real recorded responses", () => {
  it("parses the recorded CNY response", () => {
    const body = fixture(PVG_HND_CNY);
    expect(body.origin).toBe("PVG");
    expect(body.destination).toBe("HND");
    expect(body.itineraries.length).toBeGreaterThan(0);
    expect(body.itineraries.every((i) => i.price.currency === "CNY")).toBe(true);
  });

  /**
   * The shape assumption that was wrong first time round. If Ignav ever moves to the
   * documented `legs` field this fails, which is the point.
   */
  it("carries outbound/inbound rather than a legs array", () => {
    const first = fixture(PVG_HND_CNY).itineraries[0];
    expect(first).toHaveProperty("outbound");
    expect(first).toHaveProperty("inbound");
    expect(first).not.toHaveProperty("legs");
  });

  it("selects the cheapest verified fare at a plausible magnitude for the route", () => {
    const body = fixture(PVG_HND_CNY);
    const selection = selectCheapestFare(body.itineraries, "CNY", PVG_HND_THEORETICAL_USD);

    const amounts = body.itineraries.map((i) => i.price.amount);
    expect(selection.amount).toBe(Math.min(...amounts));
    // A CNY round trip on this route runs to thousands. A two- or three-digit number
    // here would mean the currency had been misread.
    expect(selection.amount as number).toBeGreaterThan(1000);
  });

  /**
   * The market parameter is what selects the currency. This is the regression guard for
   * the bug that would have shipped: no `market` means USD, and a USD fare scored
   * against a CNY baseline is not imprecise, it is meaningless.
   */
  it("refuses a USD response when the origin currency is CNY", () => {
    const body = fixture(PVG_HND_USD);
    const selection = selectCheapestFare(
      body.itineraries,
      "CNY",
      PVG_HND_THEORETICAL_USD,
    );
    expect(selection.amount).toBeNull();
    expect(selection.rejectedFor).toBe("currency-mismatch");
  });

  it("accepts the same USD response when USD is what the origin uses", () => {
    const body = fixture(PVG_HND_USD);
    const selection = selectCheapestFare(
      body.itineraries,
      "USD",
      PVG_HND_THEORETICAL_USD,
    );
    expect(selection.amount).not.toBeNull();
  });

  /**
   * The default-market capture is the only one that contains unverified fares, and it
   * shows a factor-of-four gap: the cheapest unverified was USD 117 against a cheapest
   * verified USD 464. Selecting the unverified minimum would have made an expensive
   * trunk route look like a bargain.
   */
  it("never selects an unverified fare when a verified one exists", () => {
    const body = fixture(PVG_HND_USD);
    const verified = body.itineraries
      .filter((i) => i.price.status === "verified")
      .map((i) => i.price.amount);
    const unverified = body.itineraries
      .filter((i) => i.price.status !== "verified")
      .map((i) => i.price.amount);

    expect(unverified.length).toBeGreaterThan(0);
    expect(Math.min(...unverified)).toBeLessThan(Math.min(...verified));

    const selection = selectCheapestFare(
      body.itineraries,
      "USD",
      PVG_HND_THEORETICAL_USD,
    );
    expect(selection.amount).toBe(Math.min(...verified));
  });

  it("parses the recorded KRW response and keeps its magnitude", () => {
    const body = fixture(ICN_NRT_KRW);
    expect(body.origin).toBe("ICN");
    expect(body.itineraries.every((i) => i.price.currency === "KRW")).toBe(true);

    const selection = selectCheapestFare(body.itineraries, "KRW", 240);
    expect(selection.amount as number).toBeGreaterThan(100_000);
  });

  it("handles carrier names in the local script without choking", () => {
    // market=KR localises carrier names to Korean. Nothing in the adapter should care,
    // but a parser keyed on them would.
    const carriers = fixture(ICN_NRT_KRW).itineraries.map(
      (i) => (i.outbound as { carrier?: string } | undefined)?.carrier,
    );
    expect(carriers.some((c) => typeof c === "string" && c.length > 0)).toBe(true);
  });
});

describe("selectCheapestFare", () => {
  const theoretical = 200;

  /** Named `fare` rather than `it`: a helper called `it` shadows vitest's own. */
  const fare = (
    amount: number,
    status: "verified" | "unverified" = "verified",
    currency: string = "CNY",
  ): { price: { amount: number; currency: string; status: string } } => ({
    price: { amount, currency, status },
  });

  it("picks the minimum across usable itineraries", () => {
    const selection = selectCheapestFare(
      [fare(900), fare(700), fare(1100)],
      "CNY",
      theoretical,
    );
    expect(selection.amount).toBe(700);
    expect(selection.considered).toBe(3);
  });

  it("returns a reason when there are no itineraries", () => {
    expect(selectCheapestFare([], "CNY", theoretical)).toMatchObject({
      amount: null,
      rejectedFor: "no-itineraries",
    });
    expect(selectCheapestFare(undefined, "CNY", theoretical).amount).toBeNull();
  });

  it("rejects unverified fares", () => {
    const selection = selectCheapestFare(
      [fare(80, "unverified"), fare(900, "verified")],
      "CNY",
      theoretical,
    );
    expect(selection.amount).toBe(900);
    expect(selection.considered).toBe(1);
  });

  it("rejects fares in the wrong currency and says so", () => {
    const selection = selectCheapestFare(
      [fare(900, "verified", "USD")],
      "CNY",
      theoretical,
    );
    expect(selection.amount).toBeNull();
    expect(selection.rejectedFor).toBe("currency-mismatch");
  });

  it("accepts a missing currency, since the market parameter should have set it", () => {
    const selection = selectCheapestFare(
      [{ price: { amount: 900, status: "verified" } }],
      "CNY",
      theoretical,
    );
    expect(selection.amount).toBe(900);
  });

  it("compares currency case-insensitively", () => {
    expect(
      selectCheapestFare([fare(900, "verified", "cny")], "CNY", theoretical).amount,
    ).toBe(900);
  });

  /**
   * The outlier floor is relative to the route's own median rather than to any external
   * reference, which is what makes it currency-agnostic. An earlier version compared a
   * CNY fare against a USD distance-model figure and rejected every legitimate fare.
   */
  it("drops clear outliers below the route's own median", () => {
    // Median 900, floor 180: the 50 is not a bargain, it is bad data.
    const selection = selectCheapestFare(
      [fare(50), fare(850), fare(900), fare(950)],
      "CNY",
      theoretical,
    );
    expect(selection.amount).toBe(850);
    expect(selection.considered).toBe(3);
  });

  it("keeps a uniformly cheap set rather than treating cheapness as an error", () => {
    const selection = selectCheapestFare(
      [fare(200), fare(210), fare(220), fare(230)],
      "CNY",
      theoretical,
    );
    expect(selection.amount).toBe(200);
    expect(selection.considered).toBe(4);
  });

  it("ignores non-positive and non-finite amounts", () => {
    const selection = selectCheapestFare(
      [fare(0), fare(-500), fare(Number.NaN), fare(900)],
      "CNY",
      theoretical,
    );
    expect(selection.amount).toBe(900);
  });

  it("ignores itineraries with no price object", () => {
    expect(
      selectCheapestFare([{}, { price: {} }], "CNY", theoretical).amount,
    ).toBeNull();
  });

  it("prefers the currency reason, which is the actionable one", () => {
    // Two USD fares and one CNY fare, all above any floor: the CNY one is chosen and
    // the response is not refused. The mismatch only becomes the *reason* when nothing
    // in the right currency survives.
    const mixed = selectCheapestFare(
      [fare(900, "verified", "USD"), fare(950, "verified", "USD"), fare(1000, "verified", "CNY")],
      "CNY",
      theoretical,
    );
    expect(mixed.amount).toBe(1000);

    // Nothing in the right currency at all.
    const wrongOnly = selectCheapestFare(
      [fare(900, "verified", "USD"), fare(950, "verified", "USD")],
      "CNY",
      theoretical,
    );
    expect(wrongOnly.amount).toBeNull();
    expect(wrongOnly.rejectedFor).toBe("currency-mismatch");
  });
});

describe("configuration", () => {
  it("allows a generous timeout, because the endpoint is slow and large", () => {
    // Measured: 1.3 MB and up to 88s for a long route. The shared 5s default would time
    // out every time.
    expect(internals.REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("sets the outlier ratio low enough not to discard real bargains", () => {
    expect(internals.MIN_RATIO_OF_MEDIAN).toBeLessThanOrEqual(0.25);
  });

  it("uses the same 330-day booking window the model documents", () => {
    expect(internals.BOOKING_WINDOW_DAYS).toBe(330);
  });
});
