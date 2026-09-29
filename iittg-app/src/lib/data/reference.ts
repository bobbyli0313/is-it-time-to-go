/**
 * Climate normals and FX reference data for the launch scope.
 *
 * Climate figures are monthly averages (temperature in °C, relative humidity in
 * percent) with the seasonal spread the UI discloses when it has to fall back to
 * a climate normal instead of a real forecast. The values are realistic for each
 * city but are reference data, not a live feed.
 *
 * FX reference data is likewise in-memory: `mid` is roughly the current level,
 * and `yearLow`/`yearHigh` bracket the past twelve months. The prototype only
 * needs the *shape* of the range to be plausible.
 */

export interface ClimateMonth {
  /** Mean daily temperature, °C. */
  tempC: number;
  /** Mean relative humidity, %. */
  humidityPct: number;
}

export interface CityClimate {
  /** 12 entries, January (index 0) through December (index 11). */
  months: ClimateMonth[];
  /** Typical within-month temperature spread, °C — disclosed as p25/p75 width. */
  tempSpreadC: number;
  /** Typical within-month humidity spread, percentage points. */
  humiditySpreadPct: number;
}

const TROPICAL_SPREAD = { tempSpreadC: 2.5, humiditySpreadPct: 9 };
const TEMPERATE_SPREAD = { tempSpreadC: 5, humiditySpreadPct: 14 };

function months(
  entries: Array<[number, number]>,
): ClimateMonth[] {
  return entries.map(([tempC, humidityPct]) => ({ tempC, humidityPct }));
}

export const CLIMATE: Record<string, CityClimate> = {
  shanghai: {
    ...TEMPERATE_SPREAD,
    months: months([
      [5, 73], [7, 73], [11, 73], [17, 72], [22, 73], [26, 79],
      [30, 79], [30, 79], [26, 78], [21, 73], [15, 71], [8, 70],
    ]),
  },
  beijing: {
    ...TEMPERATE_SPREAD,
    months: months([
      [-3, 44], [0, 44], [7, 42], [15, 41], [21, 46], [26, 58],
      [28, 72], [27, 75], [22, 68], [15, 58], [6, 52], [-1, 46],
    ]),
  },
  guangzhou: {
    ...TEMPERATE_SPREAD,
    months: months([
      [14, 70], [15, 76], [19, 80], [23, 80], [27, 80], [29, 82],
      [30, 79], [30, 79], [28, 76], [25, 70], [20, 66], [16, 66],
    ]),
  },
  chengdu: {
    ...TEMPERATE_SPREAD,
    months: months([
      [6, 77], [8, 76], [13, 74], [18, 72], [22, 72], [25, 77],
      [27, 81], [26, 82], [22, 83], [18, 82], [13, 80], [8, 78],
    ]),
  },
  hongkong: {
    ...TROPICAL_SPREAD,
    months: months([
      [16, 71], [17, 76], [20, 80], [24, 82], [27, 82], [29, 82],
      [29, 81], [29, 81], [28, 78], [26, 73], [22, 70], [18, 68],
    ]),
  },
  tokyo: {
    ...TEMPERATE_SPREAD,
    months: months([
      [6, 52], [7, 53], [10, 60], [15, 65], [20, 70], [23, 78],
      [27, 79], [29, 78], [25, 80], [19, 72], [13, 64], [8, 56],
    ]),
  },
  osaka: {
    ...TEMPERATE_SPREAD,
    months: months([
      [6, 60], [7, 60], [10, 62], [16, 63], [21, 67], [24, 74],
      [28, 75], [30, 73], [26, 74], [20, 68], [14, 64], [9, 60],
    ]),
  },
  sapporo: {
    ...TEMPERATE_SPREAD,
    months: months([
      [-4, 70], [-3, 69], [0, 66], [7, 62], [13, 66], [17, 74],
      [21, 78], [22, 77], [18, 72], [11, 68], [4, 68], [-1, 70],
    ]),
  },
  seoul: {
    ...TEMPERATE_SPREAD,
    months: months([
      [-2, 57], [1, 56], [7, 55], [13, 56], [19, 62], [23, 70],
      [26, 80], [27, 78], [22, 72], [15, 64], [7, 61], [0, 59],
    ]),
  },
  busan: {
    ...TEMPERATE_SPREAD,
    months: months([
      [3, 53], [5, 55], [9, 60], [14, 65], [18, 70], [21, 78],
      [25, 84], [27, 82], [23, 78], [18, 68], [11, 62], [5, 56],
    ]),
  },
  bangkok: {
    ...TROPICAL_SPREAD,
    months: months([
      [27, 68], [29, 72], [30, 73], [31, 74], [30, 76], [30, 75],
      [29, 75], [29, 76], [29, 79], [28, 77], [28, 71], [27, 66],
    ]),
  },
  phuket: {
    ...TROPICAL_SPREAD,
    months: months([
      [28, 74], [29, 73], [29, 75], [29, 78], [28, 81], [28, 81],
      [28, 80], [28, 80], [27, 83], [27, 84], [27, 81], [27, 77],
    ]),
  },
  chiangmai: {
    ...TROPICAL_SPREAD,
    months: months([
      [22, 68], [24, 62], [27, 55], [29, 58], [28, 71], [28, 76],
      [27, 78], [27, 80], [27, 80], [26, 78], [24, 74], [22, 71],
    ]),
  },
  singapore: {
    ...TROPICAL_SPREAD,
    months: months([
      [27, 84], [28, 82], [28, 83], [29, 83], [29, 83], [29, 82],
      [28, 82], [28, 82], [28, 83], [28, 84], [27, 85], [27, 85],
    ]),
  },
  kualalumpur: {
    ...TROPICAL_SPREAD,
    months: months([
      [28, 80], [28, 78], [29, 79], [29, 81], [29, 80], [29, 79],
      [28, 79], [28, 79], [28, 80], [28, 82], [28, 83], [28, 82],
    ]),
  },
  bali: {
    ...TROPICAL_SPREAD,
    months: months([
      [28, 79], [28, 79], [28, 79], [28, 78], [28, 77], [27, 76],
      [27, 74], [27, 73], [27, 75], [28, 77], [28, 78], [28, 79],
    ]),
  },
  jakarta: {
    ...TROPICAL_SPREAD,
    months: months([
      [27, 85], [27, 85], [28, 84], [28, 84], [28, 83], [28, 82],
      [28, 79], [28, 77], [28, 78], [28, 80], [28, 82], [27, 84],
    ]),
  },
  hanoi: {
    ...TEMPERATE_SPREAD,
    months: months([
      [17, 78], [18, 82], [21, 85], [25, 84], [28, 81], [30, 80],
      [30, 81], [29, 84], [28, 82], [25, 79], [21, 76], [18, 75],
    ]),
  },
  hochiminh: {
    ...TROPICAL_SPREAD,
    months: months([
      [27, 72], [28, 70], [29, 70], [30, 72], [29, 77], [28, 81],
      [28, 82], [28, 83], [27, 84], [27, 84], [27, 80], [27, 74],
    ]),
  },
  manila: {
    ...TROPICAL_SPREAD,
    months: months([
      [26, 74], [27, 72], [28, 70], [29, 69], [29, 74], [29, 79],
      [28, 82], [28, 84], [28, 84], [28, 82], [27, 79], [26, 77],
    ]),
  },
  taipei: {
    ...TEMPERATE_SPREAD,
    months: months([
      [16, 78], [17, 80], [19, 79], [23, 78], [26, 78], [29, 79],
      [31, 76], [30, 76], [28, 77], [25, 76], [21, 76], [18, 76],
    ]),
  },
};

/* --------------------------------------------------------------------- fx */

export interface FxPairReference {
  /** Units of the quote currency per 1 CNY, at roughly today's level. */
  cnyToQuote: number;
  /** Lowest level over the past 12 months, same units. */
  yearLow: number;
  /** Highest level over the past 12 months, same units. */
  yearHigh: number;
}

/**
 * Reference levels against CNY. Scoring happens on the *position within the
 * year's own range*, so these numbers only need the right shape: a volatile
 * pair (JPY, KRW, IDR) must show a wide range and a pegged one (HKD) a narrow
 * one, otherwise the confidence logic has nothing to react to.
 */
export const FX_VS_CNY: Record<string, FxPairReference> = {
  CNY: { cnyToQuote: 1, yearLow: 1, yearHigh: 1 },
  /**
   * USD is here because the flight distance model's anchor is denominated in USD
   * (`miles x $0.10`), so converting that anchor into a currency the ECB does not
   * publish — TWD, say — needs a USD leg. Its absence made every TWD-origin flight
   * dimension silently unavailable, because the fallback returned null when its own
   * dependency was missing.
   */
  USD: { cnyToQuote: 0.1408, yearLow: 0.1371, yearHigh: 0.1492 },
  HKD: { cnyToQuote: 1.1, yearLow: 1.062, yearHigh: 1.121 },
  JPY: { cnyToQuote: 23.51, yearLow: 17.5, yearHigh: 24.2 },
  KRW: { cnyToQuote: 197.5, yearLow: 168.0, yearHigh: 205.0 },
  THB: { cnyToQuote: 4.62, yearLow: 4.28, yearHigh: 5.05 },
  SGD: { cnyToQuote: 0.1845, yearLow: 0.172, yearHigh: 0.1905 },
  MYR: { cnyToQuote: 0.618, yearLow: 0.556, yearHigh: 0.665 },
  IDR: { cnyToQuote: 2255, yearLow: 1980, yearHigh: 2340 },
  VND: { cnyToQuote: 3560, yearLow: 3320, yearHigh: 3705 },
  PHP: { cnyToQuote: 8.05, yearLow: 7.18, yearHigh: 8.32 },
  TWD: { cnyToQuote: 4.42, yearLow: 4.12, yearHigh: 4.58 },
};

/**
 * Scales the reference level by a slowly varying factor so the FX score moves
 * with the chosen date instead of being pinned to a single value. Deterministic
 * in the date, so the same query always returns the same rate.
 */
export function fxRateFor(
  quoteCurrency: string,
  asOf: string,
  wobble: (currency: string, date: string) => number,
): { rate: number; yearLow: number; yearHigh: number } {
  const ref = FX_VS_CNY[quoteCurrency] ?? FX_VS_CNY.CNY;
  const factor = wobble(quoteCurrency, asOf);
  const rate = ref.cnyToQuote * factor;
  // Keep the recorded year range stable; only today's rate floats within it.
  return {
    rate: Math.min(Math.max(rate, ref.yearLow * 0.98), ref.yearHigh * 1.02),
    yearLow: ref.yearLow,
    yearHigh: ref.yearHigh,
  };
}
