/**
 * City and airport reference data.
 *
 * In production this is generated from the OurAirports / GeoNames dumps (see
 * scripts/). For the prototype it is hand-curated: the launch scope (China, Japan,
 * Korea, South-East Asia) plus the world's major long-haul hubs, because the traveller
 * typing an airport code into the form is as likely to mean LHR as PVG.
 *
 * Coverage is deliberately a curated list rather than every airport on earth: a city
 * only earns a place here when its timezone, currency, coordinates and climate are all
 * known, which is what every scoring path depends on. Anything else is rejected with
 * "that city isn't supported yet" rather than scored from a guess.
 *
 * Every city carries its own IANA timezone and currency because both are needed
 * on every scoring path — dates must be resolved per city, not per browser.
 */

import type { City } from "../scoring/types";

export const CITIES: City[] = [
  {
    id: "shanghai",
    iataCity: "SHA",
    airports: ["PVG", "SHA"],
    country: "CN",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    lat: 31.2304,
    lon: 121.4737,
    name: { en: "Shanghai", zh: "上海" },
  },
  {
    id: "beijing",
    iataCity: "BJS",
    airports: ["PEK", "PKX"],
    country: "CN",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    lat: 39.9042,
    lon: 116.4074,
    name: { en: "Beijing", zh: "北京" },
  },
  {
    id: "guangzhou",
    iataCity: "CAN",
    airports: ["CAN"],
    country: "CN",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    lat: 23.1291,
    lon: 113.2644,
    name: { en: "Guangzhou", zh: "广州" },
  },
  {
    id: "chengdu",
    iataCity: "CTU",
    airports: ["TFU", "CTU"],
    country: "CN",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    lat: 30.5728,
    lon: 104.0668,
    name: { en: "Chengdu", zh: "成都" },
  },
  {
    id: "hongkong",
    iataCity: "HKG",
    airports: ["HKG"],
    country: "HK",
    currency: "HKD",
    timezone: "Asia/Hong_Kong",
    lat: 22.3193,
    lon: 114.1694,
    name: { en: "Hong Kong", zh: "香港" },
  },
  {
    id: "tokyo",
    iataCity: "TYO",
    airports: ["HND", "NRT"],
    country: "JP",
    currency: "JPY",
    timezone: "Asia/Tokyo",
    lat: 35.6762,
    lon: 139.6503,
    name: { en: "Tokyo", zh: "东京" },
  },
  {
    id: "osaka",
    iataCity: "OSA",
    airports: ["KIX", "ITM"],
    country: "JP",
    currency: "JPY",
    timezone: "Asia/Tokyo",
    lat: 34.6937,
    lon: 135.5023,
    name: { en: "Osaka", zh: "大阪" },
  },
  {
    id: "sapporo",
    iataCity: "SPK",
    airports: ["CTS"],
    country: "JP",
    currency: "JPY",
    timezone: "Asia/Tokyo",
    lat: 43.0618,
    lon: 141.3545,
    name: { en: "Sapporo", zh: "札幌" },
  },
  {
    id: "seoul",
    iataCity: "SEL",
    airports: ["ICN", "GMP"],
    country: "KR",
    currency: "KRW",
    timezone: "Asia/Seoul",
    lat: 37.5665,
    lon: 126.978,
    name: { en: "Seoul", zh: "首尔" },
  },
  {
    id: "busan",
    iataCity: "PUS",
    airports: ["PUS"],
    country: "KR",
    currency: "KRW",
    timezone: "Asia/Seoul",
    lat: 35.1796,
    lon: 129.0756,
    name: { en: "Busan", zh: "釜山" },
  },
  {
    id: "bangkok",
    iataCity: "BKK",
    airports: ["BKK", "DMK"],
    country: "TH",
    currency: "THB",
    timezone: "Asia/Bangkok",
    lat: 13.7563,
    lon: 100.5018,
    name: { en: "Bangkok", zh: "曼谷" },
  },
  {
    id: "phuket",
    iataCity: "HKT",
    airports: ["HKT"],
    country: "TH",
    currency: "THB",
    timezone: "Asia/Bangkok",
    lat: 7.8804,
    lon: 98.3923,
    name: { en: "Phuket", zh: "普吉岛" },
  },
  {
    id: "chiangmai",
    iataCity: "CNX",
    airports: ["CNX"],
    country: "TH",
    currency: "THB",
    timezone: "Asia/Bangkok",
    lat: 18.7883,
    lon: 98.9853,
    name: { en: "Chiang Mai", zh: "清迈" },
  },
  {
    id: "singapore",
    iataCity: "SIN",
    airports: ["SIN"],
    country: "SG",
    currency: "SGD",
    timezone: "Asia/Singapore",
    lat: 1.3521,
    lon: 103.8198,
    name: { en: "Singapore", zh: "新加坡" },
  },
  {
    id: "kualalumpur",
    iataCity: "KUL",
    airports: ["KUL"],
    country: "MY",
    currency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    lat: 3.139,
    lon: 101.6869,
    name: { en: "Kuala Lumpur", zh: "吉隆坡" },
  },
  {
    id: "bali",
    iataCity: "DPS",
    airports: ["DPS"],
    country: "ID",
    currency: "IDR",
    timezone: "Asia/Makassar",
    lat: -8.4095,
    lon: 115.1889,
    name: { en: "Bali (Denpasar)", zh: "巴厘岛" },
  },
  {
    id: "jakarta",
    iataCity: "JKT",
    airports: ["CGK"],
    country: "ID",
    currency: "IDR",
    timezone: "Asia/Jakarta",
    lat: -6.2088,
    lon: 106.8456,
    name: { en: "Jakarta", zh: "雅加达" },
  },
  {
    id: "hanoi",
    iataCity: "HAN",
    airports: ["HAN"],
    country: "VN",
    currency: "VND",
    timezone: "Asia/Ho_Chi_Minh",
    lat: 21.0278,
    lon: 105.8342,
    name: { en: "Hanoi", zh: "河内" },
  },
  {
    id: "hochiminh",
    iataCity: "SGN",
    airports: ["SGN"],
    country: "VN",
    currency: "VND",
    timezone: "Asia/Ho_Chi_Minh",
    lat: 10.8231,
    lon: 106.6297,
    name: { en: "Ho Chi Minh City", zh: "胡志明市" },
  },
  {
    id: "manila",
    iataCity: "MNL",
    airports: ["MNL"],
    country: "PH",
    currency: "PHP",
    timezone: "Asia/Manila",
    lat: 14.5995,
    lon: 120.9842,
    name: { en: "Manila", zh: "马尼拉" },
  },
  {
    id: "taipei",
    iataCity: "TPE",
    airports: ["TPE", "TSA"],
    country: "TW",
    currency: "TWD",
    timezone: "Asia/Taipei",
    lat: 25.033,
    lon: 121.5654,
    name: { en: "Taipei", zh: "台北" },
  },

  /* ---------------------------------------- major long-haul hubs (2026-09-30) */

  {
    id: "london",
    iataCity: "LON",
    airports: ["LHR", "LGW"],
    country: "GB",
    currency: "GBP",
    timezone: "Europe/London",
    lat: 51.5074,
    lon: -0.1278,
    name: { en: "London", zh: "伦敦" },
  },
  {
    id: "paris",
    iataCity: "PAR",
    airports: ["CDG", "ORY"],
    country: "FR",
    currency: "EUR",
    timezone: "Europe/Paris",
    lat: 48.8566,
    lon: 2.3522,
    name: { en: "Paris", zh: "巴黎" },
  },
  {
    id: "frankfurt",
    iataCity: "FRA",
    airports: ["FRA"],
    country: "DE",
    currency: "EUR",
    timezone: "Europe/Berlin",
    lat: 50.1109,
    lon: 8.6821,
    name: { en: "Frankfurt", zh: "法兰克福" },
  },
  {
    id: "amsterdam",
    iataCity: "AMS",
    airports: ["AMS"],
    country: "NL",
    currency: "EUR",
    timezone: "Europe/Amsterdam",
    lat: 52.3676,
    lon: 4.9041,
    name: { en: "Amsterdam", zh: "阿姆斯特丹" },
  },
  {
    id: "madrid",
    iataCity: "MAD",
    airports: ["MAD"],
    country: "ES",
    currency: "EUR",
    timezone: "Europe/Madrid",
    lat: 40.4168,
    lon: -3.7038,
    name: { en: "Madrid", zh: "马德里" },
  },
  {
    id: "istanbul",
    iataCity: "IST",
    airports: ["IST"],
    country: "TR",
    currency: "TRY",
    timezone: "Europe/Istanbul",
    lat: 41.0082,
    lon: 28.9784,
    name: { en: "Istanbul", zh: "伊斯坦布尔" },
  },
  {
    id: "newyork",
    iataCity: "NYC",
    airports: ["JFK", "EWR"],
    country: "US",
    currency: "USD",
    timezone: "America/New_York",
    lat: 40.7128,
    lon: -74.006,
    name: { en: "New York", zh: "纽约" },
  },
  {
    id: "losangeles",
    iataCity: "LAX",
    airports: ["LAX"],
    country: "US",
    currency: "USD",
    timezone: "America/Los_Angeles",
    lat: 34.0522,
    lon: -118.2437,
    name: { en: "Los Angeles", zh: "洛杉矶" },
  },
  {
    id: "sanfrancisco",
    iataCity: "SFO",
    airports: ["SFO"],
    country: "US",
    currency: "USD",
    timezone: "America/Los_Angeles",
    lat: 37.7749,
    lon: -122.4194,
    name: { en: "San Francisco", zh: "旧金山" },
  },
  {
    id: "rome",
    iataCity: "ROM",
    airports: ["FCO"],
    country: "IT",
    currency: "EUR",
    timezone: "Europe/Rome",
    lat: 41.9028,
    lon: 12.4964,
    name: { en: "Rome", zh: "罗马" },
  },
  {
    id: "toronto",
    iataCity: "YTO",
    airports: ["YYZ"],
    country: "CA",
    currency: "CAD",
    timezone: "America/Toronto",
    lat: 43.6532,
    lon: -79.3832,
    name: { en: "Toronto", zh: "多伦多" },
  },
  {
    id: "dubai",
    iataCity: "DXB",
    airports: ["DXB"],
    country: "AE",
    currency: "AED",
    timezone: "Asia/Dubai",
    lat: 25.2048,
    lon: 55.2708,
    name: { en: "Dubai", zh: "迪拜" },
  },
  {
    id: "delhi",
    iataCity: "DEL",
    airports: ["DEL"],
    country: "IN",
    currency: "INR",
    timezone: "Asia/Kolkata",
    lat: 28.6139,
    lon: 77.209,
    name: { en: "Delhi", zh: "德里" },
  },
  {
    id: "sydney",
    iataCity: "SYD",
    airports: ["SYD"],
    country: "AU",
    currency: "AUD",
    timezone: "Australia/Sydney",
    lat: -33.8688,
    lon: 151.2093,
    name: { en: "Sydney", zh: "悉尼" },
  },
];

/**
 * Airport code (or city code) to city.
 *
 * One index for both, because a traveller typing "TYO" and one typing "HND" mean the
 * same trip, and the app should not care which they remembered. Ambiguity cannot
 * arise: aerodrome codes are unique, and `iataCity` codes are distinct from every
 * airport code in this table.
 */
export const CITY_BY_CODE: Map<string, City> = new Map(
  CITIES.flatMap((city) => [
    [city.iataCity.toUpperCase(), city] as const,
    ...city.airports.map((code) => [code.toUpperCase(), city] as const),
  ]),
);

/** Every code the form accepts, for the input's suggestion list. */
export const SUPPORTED_CODES: string[] = [...CITY_BY_CODE.keys()].sort();

/**
 * Resolves what the user typed.
 *
 * Tolerant about how it was typed — surrounding space, lower case — and strict about
 * what it is: an unknown code returns `undefined` so the caller can say "not supported
 * yet" rather than substitute a nearest match, which is how someone ends up booking a
 * trip to the wrong continent.
 */
export function resolveCityCode(input: string): City | undefined {
  return CITY_BY_CODE.get(input.trim().toUpperCase());
}


export const CITY_BY_ID = new Map(CITIES.map((c) => [c.id, c]));

/** Every IATA code we know about, mapped to the city that owns it. */
export const AIRPORT_TO_CITY = new Map<string, City>(
  CITIES.flatMap((c) => c.airports.map((a) => [a, c] as const)).concat(
    CITIES.map((c) => [c.iataCity, c] as const),
  ),
);

export function findCity(id: string): City | undefined {
  return CITY_BY_ID.get(id);
}

export function cityDisplayName(city: City, locale: "en" | "zh"): string {
  return city.name[locale];
}
