/**
 * Public holiday reference data.
 *
 * In production this comes from a structured source such as Nager.Date, which
 * covers ~100 countries. For the prototype it is curated for the launch scope.
 *
 * Two modelling decisions worth knowing about:
 *
 * 1. Multi-day festivals are expanded into one row per day. "Golden Week" is not
 *    a single day, and the crowding model needs per-day granularity to detect
 *    consecutive peak runs.
 * 2. Each day carries a `weight`, because a nation-wide week-long travel period
 *    (Chinese New Year) and a single bank holiday (Vesak Day) have wildly
 *    different effects on price and crowding. Treating them equally was one of
 *    the model's original weaknesses.
 *
 * Dates for lunar-calendar holidays are the officially announced ones and must
 * be refreshed yearly — they cannot be computed reliably for arbitrary years.
 */

import type { Holiday } from "../scoring/types";

export const COVERED_YEARS = [2026, 2027] as const;

export const HOLIDAYS: Holiday[] = [
  /* ------------------------------------------------------------- China */
  { date: "2026-01-01", country: "CN", name: { en: "New Year's Day", zh: "元旦" }, weight: "normal" },
  { date: "2026-02-16", country: "CN", name: { en: "Spring Festival", zh: "春节" }, weight: "peak" },
  { date: "2026-02-17", country: "CN", name: { en: "Spring Festival", zh: "春节" }, weight: "peak" },
  { date: "2026-02-18", country: "CN", name: { en: "Spring Festival", zh: "春节" }, weight: "peak" },
  { date: "2026-02-19", country: "CN", name: { en: "Spring Festival", zh: "春节" }, weight: "peak" },
  { date: "2026-02-20", country: "CN", name: { en: "Spring Festival", zh: "春节" }, weight: "peak" },
  { date: "2026-02-21", country: "CN", name: { en: "Spring Festival", zh: "春节" }, weight: "peak" },
  { date: "2026-02-22", country: "CN", name: { en: "Spring Festival", zh: "春节" }, weight: "peak" },
  { date: "2026-04-05", country: "CN", name: { en: "Qingming Festival", zh: "清明节" }, weight: "normal" },
  { date: "2026-05-01", country: "CN", name: { en: "Labour Day", zh: "劳动节" }, weight: "peak" },
  { date: "2026-05-02", country: "CN", name: { en: "Labour Day", zh: "劳动节" }, weight: "peak" },
  { date: "2026-05-03", country: "CN", name: { en: "Labour Day", zh: "劳动节" }, weight: "peak" },
  { date: "2026-06-19", country: "CN", name: { en: "Dragon Boat Festival", zh: "端午节" }, weight: "normal" },
  { date: "2026-09-25", country: "CN", name: { en: "Mid-Autumn Festival", zh: "中秋节" }, weight: "peak" },
  { date: "2026-10-01", country: "CN", name: { en: "National Day", zh: "国庆节" }, weight: "peak" },
  { date: "2026-10-02", country: "CN", name: { en: "National Day", zh: "国庆节" }, weight: "peak" },
  { date: "2026-10-03", country: "CN", name: { en: "National Day", zh: "国庆节" }, weight: "peak" },
  { date: "2026-10-04", country: "CN", name: { en: "National Day", zh: "国庆节" }, weight: "peak" },
  { date: "2026-10-05", country: "CN", name: { en: "National Day", zh: "国庆节" }, weight: "peak" },
  { date: "2026-10-06", country: "CN", name: { en: "National Day", zh: "国庆节" }, weight: "peak" },
  { date: "2026-10-07", country: "CN", name: { en: "National Day", zh: "国庆节" }, weight: "peak" },

  /* ------------------------------------------------------------- Japan */
  { date: "2026-01-01", country: "JP", name: { en: "New Year's Day", zh: "元旦" }, weight: "peak" },
  { date: "2026-01-12", country: "JP", name: { en: "Coming of Age Day", zh: "成人节" }, weight: "normal" },
  { date: "2026-02-11", country: "JP", name: { en: "National Foundation Day", zh: "建国纪念日" }, weight: "normal" },
  { date: "2026-02-23", country: "JP", name: { en: "Emperor's Birthday", zh: "天皇诞生日" }, weight: "normal" },
  { date: "2026-03-20", country: "JP", name: { en: "Vernal Equinox Day", zh: "春分节" }, weight: "normal" },
  { date: "2026-04-29", country: "JP", name: { en: "Showa Day", zh: "昭和日" }, weight: "peak" },
  { date: "2026-05-03", country: "JP", name: { en: "Constitution Memorial Day", zh: "宪法纪念日" }, weight: "peak" },
  { date: "2026-05-04", country: "JP", name: { en: "Greenery Day", zh: "绿之日" }, weight: "peak" },
  { date: "2026-05-05", country: "JP", name: { en: "Children's Day", zh: "儿童节" }, weight: "peak" },
  { date: "2026-05-06", country: "JP", name: { en: "Substitute Holiday", zh: "补休" }, weight: "peak" },
  { date: "2026-07-20", country: "JP", name: { en: "Marine Day", zh: "海之日" }, weight: "normal" },
  { date: "2026-08-11", country: "JP", name: { en: "Mountain Day", zh: "山之日" }, weight: "peak" },
  { date: "2026-08-13", country: "JP", name: { en: "Obon", zh: "盂兰盆节" }, weight: "peak" },
  { date: "2026-08-14", country: "JP", name: { en: "Obon", zh: "盂兰盆节" }, weight: "peak" },
  { date: "2026-08-15", country: "JP", name: { en: "Obon", zh: "盂兰盆节" }, weight: "peak" },
  { date: "2026-08-16", country: "JP", name: { en: "Obon", zh: "盂兰盆节" }, weight: "peak" },
  { date: "2026-09-21", country: "JP", name: { en: "Respect for the Aged Day", zh: "敬老日" }, weight: "normal" },
  { date: "2026-09-22", country: "JP", name: { en: "Citizens' Holiday", zh: "国民休日" }, weight: "normal" },
  { date: "2026-09-23", country: "JP", name: { en: "Autumnal Equinox Day", zh: "秋分节" }, weight: "normal" },
  { date: "2026-10-12", country: "JP", name: { en: "Sports Day", zh: "体育日" }, weight: "normal" },
  { date: "2026-11-03", country: "JP", name: { en: "Culture Day", zh: "文化日" }, weight: "normal" },
  { date: "2026-11-23", country: "JP", name: { en: "Labour Thanksgiving Day", zh: "勤劳感谢日" }, weight: "normal" },

  /* ------------------------------------------------------------- Korea */
  { date: "2026-01-01", country: "KR", name: { en: "New Year's Day", zh: "元旦" }, weight: "normal" },
  { date: "2026-02-16", country: "KR", name: { en: "Seollal", zh: "春节" }, weight: "peak" },
  { date: "2026-02-17", country: "KR", name: { en: "Seollal", zh: "春节" }, weight: "peak" },
  { date: "2026-02-18", country: "KR", name: { en: "Seollal", zh: "春节" }, weight: "peak" },
  { date: "2026-03-01", country: "KR", name: { en: "Independence Movement Day", zh: "三一节" }, weight: "normal" },
  { date: "2026-05-05", country: "KR", name: { en: "Children's Day", zh: "儿童节" }, weight: "normal" },
  { date: "2026-05-24", country: "KR", name: { en: "Buddha's Birthday", zh: "佛诞节" }, weight: "normal" },
  { date: "2026-06-06", country: "KR", name: { en: "Memorial Day", zh: "显忠日" }, weight: "minor" },
  { date: "2026-08-15", country: "KR", name: { en: "Liberation Day", zh: "光复节" }, weight: "normal" },
  { date: "2026-09-24", country: "KR", name: { en: "Chuseok", zh: "秋夕" }, weight: "peak" },
  { date: "2026-09-25", country: "KR", name: { en: "Chuseok", zh: "秋夕" }, weight: "peak" },
  { date: "2026-09-26", country: "KR", name: { en: "Chuseok", zh: "秋夕" }, weight: "peak" },
  { date: "2026-10-03", country: "KR", name: { en: "National Foundation Day", zh: "开天节" }, weight: "normal" },
  { date: "2026-10-09", country: "KR", name: { en: "Hangul Day", zh: "韩文节" }, weight: "minor" },
  { date: "2026-12-25", country: "KR", name: { en: "Christmas Day", zh: "圣诞节" }, weight: "normal" },

  /* -------------------------------------------------------------- Taiwan */
  { date: "2026-01-01", country: "TW", name: { en: "New Year's Day", zh: "元旦" }, weight: "normal" },
  { date: "2026-02-16", country: "TW", name: { en: "Lunar New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-02-17", country: "TW", name: { en: "Lunar New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-02-18", country: "TW", name: { en: "Lunar New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-02-19", country: "TW", name: { en: "Lunar New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-02-28", country: "TW", name: { en: "Peace Memorial Day", zh: "和平纪念日" }, weight: "normal" },
  { date: "2026-04-04", country: "TW", name: { en: "Children's Day", zh: "儿童节" }, weight: "normal" },
  { date: "2026-04-05", country: "TW", name: { en: "Tomb Sweeping Day", zh: "清明节" }, weight: "peak" },
  { date: "2026-06-19", country: "TW", name: { en: "Dragon Boat Festival", zh: "端午节" }, weight: "normal" },
  { date: "2026-09-25", country: "TW", name: { en: "Mid-Autumn Festival", zh: "中秋节" }, weight: "peak" },
  { date: "2026-10-10", country: "TW", name: { en: "National Day", zh: "双十节" }, weight: "peak" },

  /* ------------------------------------------------------------ Thailand */
  { date: "2026-01-01", country: "TH", name: { en: "New Year's Day", zh: "元旦" }, weight: "peak" },
  { date: "2026-03-03", country: "TH", name: { en: "Makha Bucha", zh: "万佛节" }, weight: "normal" },
  { date: "2026-04-06", country: "TH", name: { en: "Chakri Memorial Day", zh: "却克里王朝纪念日" }, weight: "normal" },
  { date: "2026-04-13", country: "TH", name: { en: "Songkran", zh: "泼水节" }, weight: "peak" },
  { date: "2026-04-14", country: "TH", name: { en: "Songkran", zh: "泼水节" }, weight: "peak" },
  { date: "2026-04-15", country: "TH", name: { en: "Songkran", zh: "泼水节" }, weight: "peak" },
  { date: "2026-05-01", country: "TH", name: { en: "Labour Day", zh: "劳动节" }, weight: "normal" },
  { date: "2026-06-01", country: "TH", name: { en: "Visakha Bucha", zh: "卫塞节" }, weight: "normal" },
  { date: "2026-07-29", country: "TH", name: { en: "Asarnha Bucha", zh: "三宝节" }, weight: "normal" },
  { date: "2026-08-12", country: "TH", name: { en: "Queen's Birthday", zh: "王太后诞辰" }, weight: "peak" },
  { date: "2026-10-13", country: "TH", name: { en: "King Bhumibol Memorial Day", zh: "先王纪念日" }, weight: "normal" },
  { date: "2026-10-23", country: "TH", name: { en: "Chulalongkorn Day", zh: "朱拉隆功日" }, weight: "normal" },
  { date: "2026-12-05", country: "TH", name: { en: "Father's Day", zh: "父亲节" }, weight: "peak" },
  { date: "2026-12-31", country: "TH", name: { en: "New Year's Eve", zh: "跨年夜" }, weight: "peak" },

  /* ---------------------------------------------------------- Singapore */
  { date: "2026-01-01", country: "SG", name: { en: "New Year's Day", zh: "元旦" }, weight: "normal" },
  { date: "2026-02-17", country: "SG", name: { en: "Chinese New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-02-18", country: "SG", name: { en: "Chinese New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-04-03", country: "SG", name: { en: "Good Friday", zh: "耶稣受难日" }, weight: "normal" },
  { date: "2026-05-01", country: "SG", name: { en: "Labour Day", zh: "劳动节" }, weight: "normal" },
  { date: "2026-05-31", country: "SG", name: { en: "Vesak Day", zh: "卫塞节" }, weight: "normal" },
  { date: "2026-08-09", country: "SG", name: { en: "National Day", zh: "国庆日" }, weight: "peak" },
  { date: "2026-11-08", country: "SG", name: { en: "Deepavali", zh: "屠妖节" }, weight: "normal" },
  { date: "2026-12-25", country: "SG", name: { en: "Christmas Day", zh: "圣诞节" }, weight: "normal" },

  /* ----------------------------------------------------------- Malaysia */
  { date: "2026-01-01", country: "MY", name: { en: "New Year's Day", zh: "元旦" }, weight: "normal" },
  { date: "2026-02-17", country: "MY", name: { en: "Chinese New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-02-18", country: "MY", name: { en: "Chinese New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-05-01", country: "MY", name: { en: "Labour Day", zh: "劳动节" }, weight: "normal" },
  { date: "2026-05-31", country: "MY", name: { en: "Vesak Day", zh: "卫塞节" }, weight: "normal" },
  { date: "2026-06-01", country: "MY", name: { en: "Agong's Birthday", zh: "最高元首诞辰" }, weight: "normal" },
  { date: "2026-08-31", country: "MY", name: { en: "National Day", zh: "国庆日" }, weight: "peak" },
  { date: "2026-09-16", country: "MY", name: { en: "Malaysia Day", zh: "马来西亚日" }, weight: "normal" },
  { date: "2026-11-08", country: "MY", name: { en: "Deepavali", zh: "屠妖节" }, weight: "normal" },
  { date: "2026-12-25", country: "MY", name: { en: "Christmas Day", zh: "圣诞节" }, weight: "normal" },

  /* ---------------------------------------------------------- Indonesia */
  { date: "2026-01-01", country: "ID", name: { en: "New Year's Day", zh: "元旦" }, weight: "peak" },
  { date: "2026-03-19", country: "ID", name: { en: "Nyepi", zh: "静居日" }, weight: "peak" },
  { date: "2026-04-03", country: "ID", name: { en: "Good Friday", zh: "耶稣受难日" }, weight: "normal" },
  { date: "2026-05-01", country: "ID", name: { en: "Labour Day", zh: "劳动节" }, weight: "normal" },
  { date: "2026-05-14", country: "ID", name: { en: "Ascension of Jesus", zh: "耶稣升天节" }, weight: "normal" },
  { date: "2026-06-01", country: "ID", name: { en: "Pancasila Day", zh: "潘查希拉日" }, weight: "normal" },
  { date: "2026-08-17", country: "ID", name: { en: "Independence Day", zh: "独立日" }, weight: "peak" },
  { date: "2026-12-25", country: "ID", name: { en: "Christmas Day", zh: "圣诞节" }, weight: "peak" },

  /* ------------------------------------------------------------- Vietnam */
  { date: "2026-01-01", country: "VN", name: { en: "New Year's Day", zh: "元旦" }, weight: "normal" },
  { date: "2026-02-16", country: "VN", name: { en: "Tet", zh: "春节" }, weight: "peak" },
  { date: "2026-02-17", country: "VN", name: { en: "Tet", zh: "春节" }, weight: "peak" },
  { date: "2026-02-18", country: "VN", name: { en: "Tet", zh: "春节" }, weight: "peak" },
  { date: "2026-02-19", country: "VN", name: { en: "Tet", zh: "春节" }, weight: "peak" },
  { date: "2026-02-20", country: "VN", name: { en: "Tet", zh: "春节" }, weight: "peak" },
  { date: "2026-04-16", country: "VN", name: { en: "Hung Kings' Commemoration", zh: "雄王纪念日" }, weight: "normal" },
  { date: "2026-04-30", country: "VN", name: { en: "Reunification Day", zh: "统一日" }, weight: "peak" },
  { date: "2026-05-01", country: "VN", name: { en: "Labour Day", zh: "劳动节" }, weight: "peak" },
  { date: "2026-09-02", country: "VN", name: { en: "National Day", zh: "国庆日" }, weight: "peak" },

  /* ---------------------------------------------------------- Philippines */
  { date: "2026-01-01", country: "PH", name: { en: "New Year's Day", zh: "元旦" }, weight: "peak" },
  { date: "2026-04-02", country: "PH", name: { en: "Maundy Thursday", zh: "濯足节" }, weight: "peak" },
  { date: "2026-04-03", country: "PH", name: { en: "Good Friday", zh: "耶稣受难日" }, weight: "peak" },
  { date: "2026-04-09", country: "PH", name: { en: "Day of Valor", zh: "勇士日" }, weight: "normal" },
  { date: "2026-05-01", country: "PH", name: { en: "Labour Day", zh: "劳动节" }, weight: "normal" },
  { date: "2026-06-12", country: "PH", name: { en: "Independence Day", zh: "独立日" }, weight: "peak" },
  { date: "2026-08-31", country: "PH", name: { en: "National Heroes Day", zh: "国家英雄日" }, weight: "normal" },
  { date: "2026-11-30", country: "PH", name: { en: "Bonifacio Day", zh: "博尼法西奥日" }, weight: "normal" },
  { date: "2026-12-25", country: "PH", name: { en: "Christmas Day", zh: "圣诞节" }, weight: "peak" },
  { date: "2026-12-30", country: "PH", name: { en: "Rizal Day", zh: "黎刹日" }, weight: "normal" },

  /* -------------------------------------------------------- Hong Kong */
  { date: "2026-01-01", country: "HK", name: { en: "New Year's Day", zh: "元旦" }, weight: "normal" },
  { date: "2026-02-17", country: "HK", name: { en: "Lunar New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-02-18", country: "HK", name: { en: "Lunar New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-02-19", country: "HK", name: { en: "Lunar New Year", zh: "农历新年" }, weight: "peak" },
  { date: "2026-04-03", country: "HK", name: { en: "Good Friday", zh: "耶稣受难日" }, weight: "normal" },
  { date: "2026-04-05", country: "HK", name: { en: "Ching Ming Festival", zh: "清明节" }, weight: "normal" },
  { date: "2026-05-01", country: "HK", name: { en: "Labour Day", zh: "劳动节" }, weight: "normal" },
  { date: "2026-06-19", country: "HK", name: { en: "Tuen Ng Festival", zh: "端午节" }, weight: "normal" },
  { date: "2026-07-01", country: "HK", name: { en: "HKSAR Establishment Day", zh: "香港特别行政区成立纪念日" }, weight: "normal" },
  { date: "2026-09-26", country: "HK", name: { en: "Day after Mid-Autumn", zh: "中秋节翌日" }, weight: "normal" },
  { date: "2026-10-01", country: "HK", name: { en: "National Day", zh: "国庆日" }, weight: "peak" },
  { date: "2026-10-19", country: "HK", name: { en: "Chung Yeung Festival", zh: "重阳节" }, weight: "normal" },
  { date: "2026-12-25", country: "HK", name: { en: "Christmas Day", zh: "圣诞节" }, weight: "normal" },
];

/** All holidays for a country, sorted by date. */
export function holidaysForCountry(country: string): Holiday[] {
  return HOLIDAYS.filter((h) => h.country === country).sort((a, b) =>
    a.date < b.date ? -1 : 1,
  );
}

/**
 * Holidays overlapping an inclusive date range, for the given country.
 * When the requested year is outside the loaded data the caller gets an empty
 * list — which would silently score as "no crowding", so `hasCoverage` exists
 * to let the UI disclose the gap instead.
 */
export function holidaysInRange(
  country: string,
  from: string,
  to: string,
): Holiday[] {
  return HOLIDAYS.filter(
    (h) => h.country === country && h.date >= from && h.date <= to,
  );
}

export function hasHolidayCoverage(year: number): boolean {
  return (COVERED_YEARS as readonly number[]).includes(year);
}
