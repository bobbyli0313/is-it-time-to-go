/**
 * The scoring anchor, in the destination's own currency.
 *
 * The brief scores a city's hotel prices against **¥500 per night**: at or below
 * it is full marks, and above it the score decays. That anchor is denominated in
 * CNY, so a dataset has to state it in the city's currency — and because exchange
 * rates move, it has to say *when* it was converted, or a score would silently
 * drift with the FX market rather than with hotel prices.
 *
 * Conversion goes through the USD legs the FX module already maintains
 * (`usdRateTo`), which covers the ECB basket live and falls back to the curated
 * table for TWD and VND. When neither is available the function returns a named
 * failure rather than a made-up rate: a wrong baseline moves every hotel score in
 * the city, and there is no way for a user to notice.
 */

import { usdRateTo } from "../live/fx";
import { FX_VS_CNY } from "../reference";
import { PARAMS } from "../../scoring/dimensions";

export interface BaselineConversion {
  currency: string;
  /** The ¥500 anchor expressed in `currency`. */
  baselineLocal: number;
  /** Where the rate came from, for the dataset's audit trail. */
  source: "ecb" | "static-reference";
  asOf: string;
}

export type BaselineResult =
  | { ok: true; data: BaselineConversion }
  | { ok: false; detail: string };

/** How many units of a currency one USD buys. Injectable so this is testable. */
export type UsdRateLookup = (currency: string, now: Date) => Promise<number | null>;

/**
 * Converts the ¥500 anchor into `currency`.
 *
 * ## The direction of the rate, which is where this went wrong once
 *
 * `usdRateTo(x)` answers *how many units of `x` one USD buys* — 7.1 for CNY, about
 * 150 for JPY. The conversion therefore divides, it does not multiply:
 *
 * ```
 * JPY per CNY = usdRateTo(JPY) / usdRateTo(CNY) = 150 / 7.1 ≈ 21.1
 * ¥500        = 500 × 21.1 ≈ 10,550 JPY
 * ```
 *
 * The first version had that ratio inverted and produced a baseline of **21 JPY**,
 * which made every hotel in Tokyo look 460× the anchor and pinned the hotel
 * dimension to its floor. Nothing failed loudly — the number was simply wrong by a
 * factor of 500 — which is why `baseline.test.ts` now pins the direction with rates
 * that could not be mistaken for each other.
 *
 * The curated table is the fallback rather than the default: it is a reference level,
 * not a rate, and using it while the ECB answers would bake a stale number into a
 * dataset that is supposed to last months.
 */
export async function baselineForCurrency(
  currency: string,
  now: Date = new Date(),
  lookup: UsdRateLookup = usdRateTo,
): Promise<BaselineResult> {
  const asOf = now.toISOString();

  const [cnyPerUsd, localPerUsd] = await Promise.all([
    lookup("CNY", now),
    lookup(currency, now),
  ]);

  if (cnyPerUsd !== null && localPerUsd !== null && cnyPerUsd > 0) {
    return {
      ok: true,
      data: {
        currency,
        baselineLocal:
          Math.round(PARAMS.hotel.baselineCny * (localPerUsd / cnyPerUsd) * 100) / 100,
        source: "ecb",
        asOf,
      },
    };
  }

  const cnyToQuote = FX_VS_CNY[currency]?.cnyToQuote;
  if (cnyToQuote && cnyToQuote > 0) {
    return {
      ok: true,
      data: {
        currency,
        baselineLocal: Math.round(PARAMS.hotel.baselineCny * cnyToQuote * 100) / 100,
        source: "static-reference",
        asOf,
      },
    };
  }

  return {
    ok: false,
    detail: `No CNY→${currency} rate available from the ECB or the curated table`,
  };
}
