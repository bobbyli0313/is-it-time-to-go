/**
 * Tests for the Ignav flight adapter.
 *
 * The request and response shapes come from Ignav's published OpenAPI document
 * (`https://ignav.com/api/openapi.json`), which is the real contract rather than
 * prose documentation. No fare response has been observed, because a key requires
 * signup and none was available — so these tests cover the parsing and filtering
 * logic that would otherwise be trusted on faith.
 *
 * The filtering matters more than it looks. The score compares a fare against an
 * origin-currency baseline, so a fare quoted in the wrong currency would not merely
 * be imprecise, it would be nonsense. A defensive filter that returns "unavailable"
 * is strictly better than a number that is quietly wrong.
 */

import { describe, expect, it } from "vitest";
import {
  cheapestFare,
  FlightUpstreamError,
  internals,
} from "@/lib/data/live/flights";

describe("cheapestFare", () => {
  it("picks the minimum amount across itineraries", () => {
    const fare = cheapestFare(
      [
        { price: { amount: 3200, currency: "CNY", status: "available" } },
        { price: { amount: 2100, currency: "CNY", status: "available" } },
        { price: { amount: 4500, currency: "CNY", status: "available" } },
      ],
      "CNY",
    );
    expect(fare).toBe(2100);
  });

  it("returns null for an empty or missing list", () => {
    expect(cheapestFare([], "CNY")).toBeNull();
    expect(cheapestFare(undefined, "CNY")).toBeNull();
  });

  it("ignores non-positive and non-finite amounts", () => {
    const fare = cheapestFare(
      [
        { price: { amount: 0, currency: "CNY" } },
        { price: { amount: -100, currency: "CNY" } },
        { price: { amount: Number.NaN, currency: "CNY" } },
        { price: { amount: 1800, currency: "CNY" } },
      ],
      "CNY",
    );
    expect(fare).toBe(1800);
  });

  it("ignores entries with no price at all", () => {
    expect(cheapestFare([{}, { legs: [] }], "CNY")).toBeNull();
  });

  /**
   * The important one: a fare in a different currency cannot be compared against the
   * origin-currency baseline, so it is discarded rather than converted on a guess.
   */
  it("discards fares quoted in a different currency", () => {
    const fare = cheapestFare(
      [
        { price: { amount: 300, currency: "USD" } },
        { price: { amount: 2500, currency: "CNY" } },
      ],
      "CNY",
    );
    expect(fare).toBe(2500);
  });

  it("returns null when every fare is in the wrong currency", () => {
    expect(
      cheapestFare([{ price: { amount: 300, currency: "USD" } }], "CNY"),
    ).toBeNull();
  });

  it("compares currency case-insensitively", () => {
    expect(
      cheapestFare([{ price: { amount: 2500, currency: "cny" } }], "CNY"),
    ).toBe(2500);
  });

  it("keeps a fare when the currency is absent rather than discarding it", () => {
    // The origin currency is the documented default; an omitted field is not evidence
    // of a mismatch.
    expect(cheapestFare([{ price: { amount: 2500 } }], "CNY")).toBe(2500);
  });

  it("drops explicitly unavailable or sold-out fares", () => {
    const fare = cheapestFare(
      [
        { price: { amount: 100, currency: "CNY", status: "unavailable" } },
        { price: { amount: 200, currency: "CNY", status: "sold_out" } },
        { price: { amount: 300, currency: "CNY", status: "expired" } },
        { price: { amount: 2500, currency: "CNY", status: "available" } },
      ],
      "CNY",
    );
    expect(fare).toBe(2500);
  });

  /**
   * The status vocabulary is not enumerated in the schema. Only values that clearly
   * mean "not bookable" are dropped, so an unrecognised word does not silently
   * discard every result and turn the dimension into a permanent "unavailable".
   */
  it("keeps a fare whose status is an unrecognised word", () => {
    expect(
      cheapestFare(
        [{ price: { amount: 2200, currency: "CNY", status: "some_new_status" } }],
        "CNY",
      ),
    ).toBe(2200);
  });

  it("keeps a fare with no status field", () => {
    expect(
      cheapestFare([{ price: { amount: 2200, currency: "CNY" } }], "CNY"),
    ).toBe(2200);
  });
});

describe("booking window", () => {
  it("uses the same 330-day window the model documents", () => {
    // Kept in one place so the mock and live paths cannot drift apart on what counts
    // as "outside the booking window".
    expect(internals.BOOKING_WINDOW_DAYS).toBe(330);
  });

  it("treats only a date-range rejection from the upstream as a window problem", () => {
    // A 400 mentioning dates means the airline has not opened the window, which the
    // UI reports as "bookings open on X" rather than as a generic failure.
    expect(
      internals.isBookingWindowError(
        new FlightUpstreamError("ignav 400", 400, "invalid departure date range"),
      ),
    ).toBe(true);

    // A 400 for some other reason is not a window problem.
    expect(
      internals.isBookingWindowError(
        new FlightUpstreamError("ignav 400", 400, "unsupported cabin class"),
      ),
    ).toBe(false);

    // Nor is a 500, however it is worded.
    expect(
      internals.isBookingWindowError(
        new FlightUpstreamError("ignav 500", 500, "invalid internal date state"),
      ),
    ).toBe(false);

    expect(internals.isBookingWindowError(null)).toBe(false);
    expect(internals.isBookingWindowError(new Error("nope"))).toBe(false);
  });
});
