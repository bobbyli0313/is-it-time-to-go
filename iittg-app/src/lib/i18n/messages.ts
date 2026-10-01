/**
 * Internationalisation.
 *
 * Scope note: the app is English-first, with Chinese included because the launch
 * scope targets travellers departing China. The dictionary is a plain typed
 * object rather than a framework — there are only two locales and a few dozen
 * strings, so `next-intl` would be more configuration than product. The shape
 * is deliberately compatible with one: keys are flat and namespaced, so moving
 * to a real i18n library later is a mechanical swap.
 *
 * Critical detail: the *scoring layer never emits prose*. It emits i18n keys
 * (see `drivers` in `DimensionScore`), and this file is the only place that turns
 * them into sentences. That is what lets the same score be explained in any
 * language without duplicating the model.
 */

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

const en = {
  "app.title": "Is It Time To Go?",
  "app.tagline":
    "One score for when is the good time for your trip, built from real time data.",

  "form.heading": "Plan a trip",
  "form.routeGroup": "Where",
  "form.datesGroup": "When",
  "form.swapShort": "Swap",
  "form.departHint": "{from} – {to}",
  "form.origin": "From",
  "form.destination": "To",
  "form.departDate": "Depart",
  "form.returnDate": "Return",
  "form.travellers": "Travellers",
  "form.submit": "Score this trip",
  "form.scoring": "Scoring…",
  "form.codeHint": "IATA airport or city code — PVG, HND, LHR",
  "form.cityUnsupported": "That city isn't supported yet",
  "form.swap": "Swap origin and destination",
  "form.tripLength": "{days} days",
  "form.routeUnavailable": "Origin and destination must be different cities",
  "form.dateRange": "Departure must be between today and 30 days from today",
  "form.returnBeforeDepart": "Return date must be on or after the departure date",

  "result.heading": "Your trip score",
  "result.outOf": "out of 100",
  "result.days": "{days}-day trip",
  "result.attributionHeading": "What is costing you points",
  "result.attributionNone": "Nothing is dragging this trip down.",
  "result.factDetails": "Data details",
  "result.cappedBy": "Capped at {cap} because {dimension} is a dealbreaker",
  "result.reset": "Start over",

  "result.dataSources": "Where this data comes from",
  "source.weather.live-open-meteo": "Live · Open-Meteo",
  "source.weather.mock": "Sample data",
  "source.holidays.live-nager-date": "Live · Nager.Date",
  "source.holidays.mock": "Sample data",
  "source.flight.live-ignav": "Live · Ignav",
  "source.flight.mock": "Sample data",
  "source.hotel.collected-hotelbeds": "Hotelbeds · rates collected by this app",
  "source.hotel.mock": "Sample data (synthetic — no dataset collected)",
  "source.fx.live-ecb": "Live · ECB reference rates",
  "source.fx.static-reference": "Static reference table",
  "source.fx.mock": "Sample data",
  "source.fx.not-applicable": "Same currency",
  "error.invalidRequest": "That request was not understood.",
  "error.invalidResponse": "The server returned an unexpected response.",
  "error.timeout": "Scoring took too long. Please try again.",
  "error.network": "Could not reach the scoring service.",
  "error.upstreamUnavailable": "A data source is unavailable right now, so no score can be given. Please try again in a moment.",
  "warning.holidayCoverageSpanningYears": "This trip spans a year boundary, and holiday calendars are published per year — coverage may be incomplete.",
  "warning.hotelIsMockNoCity": "No hotel properties have been collected for this city yet, so hotel pricing was excluded.",
  "warning.hotelSamplesMissing": "No hotel prices were collected near these dates, so hotel pricing was excluded. Run the collector for this city to cover it.",
  "warning.hotelJustCollected":
    "No prices had been collected for this destination, so this request collected them. The hotel figure comes from that collection.",
  "warning.hotelCollectionBudget":
    "Prices for this destination could not be collected because today's collection budget is spent. They will be collected automatically on a later request.",
  "warning.hotelCollectionFailed":
    "Collecting prices for this destination failed, so the hotel dimension is excluded. The reason is in the server log.",
  "warning.hotelDataIsStale": "The collected hotel prices are several months old, so the reference price may have moved.",
  "warning.holidaySourceIncomplete": "The public holiday calendar for this period could not be fully retrieved, so the crowding estimate is based on weekends only.",
  "warning.fxFromStaticTable": "This currency pair is outside the ECB's published basket, so the exchange rate comes from a static reference table rather than a live feed.",
  "dimension.weather": "Weather",
  "dimension.hotel": "Hotel prices",
  "dimension.flight": "Flight prices",
  "dimension.crowd": "Crowding",
  "dimension.fx": "Exchange rate",


  "fact.basis": "Source",
  "fact.temp": "Temperature",
  "fact.humidity": "Humidity",
  "fact.precip": "Chance of rain",
  "fact.spread": "Typical range",
  "fact.sampledDate": "Sampled day",
  /**
   * One key per fact the scorers emit. The card looks up `fact.<key>` for every
   * entry in `DimensionScore.facts`, so a missing key renders as a raw identifier —
   * which is why `messages.test.ts` now walks the facts too, not just the drivers.
   */
  "fact.date": "Sampled date",
  "fact.tempC": "Temperature",
  "fact.humidityPct": "Humidity",
  "fact.tempSpreadC": "Typical temperature range",
  "fact.humiditySpreadPct": "Typical humidity range",
  "fact.precipProbabilityPct": "Chance of rain",
  "fact.fareLocal": "Fare (origin currency)",
  "fact.ageHours": "Quote age (hours)",
  "fact.theoreticalUsd": "Distance-based fare (USD)",
  "fact.historyMin": "Lowest fare observed",
  "fact.historyMedian": "Median fare observed",
  "fact.historyMax": "Highest fare observed",
  "fact.fareToTheoreticalRatio": "Fare vs distance model",
  "fact.unavailable": "Reason",
  "fact.tripDays": "Trip length (days)",
  "fact.holidayCount": "Public holidays in range",
  "fact.weekendDays": "Weekend days",
  "fact.holidayPressureDays": "Weighted holiday days",
  "fact.longestPeakRun": "Longest peak run (days)",
  "fact.from": "From currency",
  "fact.to": "To currency",
  "fact.yearLow": "12-month low",
  "fact.yearHigh": "12-month high",
  "fact.rangePct": "Range width",
  "fact.positionInRange": "Position in 12-month range",
  "fact.asOf": "Rate as of",
  "fact.fetchedAt": "Prices updated",
  "weather.basis.forecast": "Forecast",
  "weather.basis.climate-normal": "Climate normal (historical average)",
  "weather.driver.tempIdeal": "Near the 25 °C ideal",
  "weather.driver.tempHot": "Hotter than ideal",
  "weather.driver.tempCold": "Colder than ideal",
  "weather.driver.humidityIdeal": "Near the 50% humidity ideal",
  "weather.driver.humidityHumid": "More humid than ideal",
  "weather.driver.humidityDry": "Drier than ideal",
  "weather.driver.forecast": "Real forecast",
  "weather.driver.climateNormal": "Historical average, not a forecast",

  "fact.perNight": "Median nightly rate",
  "fact.baseline": "Baseline (¥500 equivalent)",
  "fact.index": "Price vs baseline",
  "fact.sampleSize": "Properties with prices",
  "fact.propertyUniverse": "Properties known in this city",
  "fact.disclosure": "Prices published",
  "fact.indexPctVsBaseline": "Distance from the ¥500 anchor",
  "hotel.disclosure.price": "Amount",
  "hotel.disclosure.index": "Index only",
  "fact.collectedAt": "Prices collected",
  "fact.holidayLift": "Holiday price lift",
  "fact.seasonalFactor": "Seasonal factor",
  "fact.nearbyHolidayDays": "Holidays within ±3 days",
  "fact.medianNotBookable": "Collected median — not a bookable rate",
  "hotel.basis.collected-median": "Hotelbeds median rate",
  "hotel.basis.mock-flat": "Sample data (synthetic index)",
  "hotel.driver.collectedMedian": "Median of Hotelbeds rates",
  "hotel.driver.mockFlat": "Synthetic sample data",
  "hotel.driver.belowBaseline": "At or below ¥500 a night",
  "hotel.driver.aboveBaseline": "Above ¥500 a night",
  "hotel.driver.farAboveBaseline": "Well above ¥500 a night",
  "hotel.driver.thinSample": "Few properties sampled",
  "hotel.driver.staleSamples": "Prices are months old",
  "hotel.driver.notCollected": "No prices collected yet",
  "hotel.driver.indexOnly": "Index only — amounts not published",

  "fact.fare": "Lowest round-trip fare",
  "fact.updated": "Prices updated",
  "fact.theoretical": "Distance-based theoretical fare (USD)",
  "fact.theoreticalLocal": "Theoretical fare in origin currency",
  "fact.ratio": "Fare vs theoretical",
  "fact.percentile": "Percentile in route history",
  "fact.historyRange": "Typical range",
  "fact.lookback": "Lookback window",
  "fact.bookingOpens": "Bookings open",
  "fact.bookingOpensOn": "Bookings open",
  "fact.lookbackDays": "Lookback window (days)",
  "flight.basis.cached-fare": "Cached fare",
  "flight.basis.distance-model": "Distance model",
  "flight.basis.blended": "Blended estimate",
  "flight.driver.percentile": "Versus this route's own history",
  "flight.driver.newLow": "Cheapest in the lookback window",
  "flight.driver.cheapVsHistory": "Cheaper than usual",
  "flight.driver.typicalVsHistory": "Typical for this route",
  "flight.driver.expensiveVsHistory": "Dearer than usual",
  "flight.driver.distanceModel": "No fare history — distance model",
  "flight.driver.atOrBelowTheoretical": "At or below the distance estimate",
  "flight.driver.aboveTheoretical": "Above the distance estimate",
  "flight.driver.outsideBookingWindow": "Not on sale yet",
  "flight.driver.noQuote": "No fare for these dates",
  "flight.driver.noFxForAnchor": "No exchange rate for the fare comparison",
  "flight.driver.blended": "Blended recent fares",
  "flight.driver.staleQuote": "Cached fare may be stale",

  "fact.holidays": "Public holidays in range",
  "fact.holidayDates": "Holiday dates",
  "fact.weekends": "Weekend days",
  "fact.peakRun": "Longest consecutive holiday run",
  "fact.pressure": "Holiday pressure",
  "crowd.driver.noHolidays": "No public holidays",
  "crowd.driver.hasHolidays": "Public holidays in your dates",
  "crowd.driver.peakRun": "A run of consecutive holidays",
  "crowd.driver.weekendsCounted": "Weekends counted in",
  "crowd.driver.proxyOnly": "Estimated, not measured footfall",

  "fact.pair": "Currency pair",
  "fact.rate": "Current rate",
  "fact.yearRange": "12-month range",
  "fact.rangeWidth": "Range width",
  "fact.position": "Position in range",
  "fx.driver.flatRange": "This pair barely moves",
  "fx.driver.nearYearHigh": "Near a 12-month high",
  "fx.driver.nearYearLow": "Near a 12-month low",
  "fx.driver.midRange": "Mid-range for the year",
  "fx.driver.higherIsBetter": "A stronger rate buys more on arrival",
  "fx.driver.sameCurrency": "Same currency at both ends",

  "warning.lowConfidenceDimensions":
    "Some dimensions rely on low-confidence data. Treat the total as a rough signal.",
  "warning.weatherIsClimateNormal":
    "Weather uses a historical average, not a forecast — it cannot predict a specific day this far ahead.",
  "warning.hotelIsMock":
    "Hotel prices are synthetic sample data — no price dataset has been collected.",
  "warning.flightUnavailable":
    "No fare is available for these dates, so flight price is excluded from the total rather than counted as zero.",
  "warning.flightNotCachedFare":
    "Flight pricing falls back to the distance model because no fare history exists for this route.",
  "warning.totalCappedByWeakDimension":
    "One dimension is low enough that the total has been capped.",
  "warning.sameCurrency":
    "Origin and destination use the same currency, so exchange rate is excluded.",
  "warning.holidayCoverageIncomplete":
    "Holiday data does not cover every year in this range, so crowding may be understated.",

  "footer.disclaimer":
    "Weather, holidays, exchange rates and hotel prices are live where a source is configured; dimensions without one are labelled as sample data.",
  "footer.language": "Language",

  "time.justNow": "just now",
  "time.hoursAgo": "{hours}h ago",
  "time.daysAgo": "{days}d ago",
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "app.title": "该出发了吗？",
  "app.tagline":
    "用真实数据，为「现在适不适合去」给出一个分数。",

  "form.heading": "规划一次旅行",
  "form.routeGroup": "去哪里",
  "form.datesGroup": "什么时候",
  "form.swapShort": "交换",
  "form.departHint": "{from} – {to}",
  "form.origin": "出发地",
  "form.destination": "目的地",
  "form.departDate": "出发日期",
  "form.returnDate": "返回日期",
  "form.travellers": "出行人数",
  "form.submit": "计算分数",
  "form.scoring": "计算中…",
  "form.codeHint": "机场或城市三字码 — 如 PVG、HND、LHR",
  "form.cityUnsupported": "暂不支持该城市",
  "form.swap": "交换出发地与目的地",
  "form.tripLength": "{days} 天",
  "form.routeUnavailable": "出发地与目的地不能是同一座城市",
  "form.dateRange": "出发日期需在今天至 30 天之内",
  "form.returnBeforeDepart": "返回日期不能早于出发日期",

  "result.heading": "本次旅行得分",
  "result.outOf": "满分 100",
  "result.days": "{days} 天行程",
  "result.attributionHeading": "扣分来自哪里",
  "result.attributionNone": "没有明显拖累这次旅行的因素。",
  "result.factDetails": "数据明细",
  "result.cappedBy": "因「{dimension}」过低，总分被限制在 {cap} 分",
  "result.reset": "重新开始",

  "result.dataSources": "数据来源",
  "source.weather.live-open-meteo": "实时 · Open-Meteo",
  "source.weather.mock": "示例数据",
  "source.holidays.live-nager-date": "实时 · Nager.Date",
  "source.holidays.mock": "示例数据",
  "source.flight.live-ignav": "实时 · Ignav",
  "source.flight.mock": "示例数据",
  "source.hotel.collected-hotelbeds": "Hotelbeds · 自行采集的房价",
  "source.hotel.mock": "示例数据（合成，尚未采集数据集）",
  "source.fx.live-ecb": "实时 · 欧洲央行参考汇率",
  "source.fx.static-reference": "静态参考表",
  "source.fx.mock": "示例数据",
  "source.fx.not-applicable": "同一货币",
  "error.invalidRequest": "请求无法识别。",
  "error.invalidResponse": "服务器返回了非预期的响应。",
  "error.timeout": "计算超时，请重试。",
  "error.network": "无法连接到评分服务。",
  "error.upstreamUnavailable": "数据源暂时不可用，无法给出评分，请稍后重试。",
  "warning.holidayCoverageSpanningYears": "该行程跨越年份，而假期日历按年发布，覆盖可能不完整。",
  "warning.hotelIsMockNoCity": "该城市尚未采集任何酒店样本，酒店价格维度已排除。",
  "warning.hotelSamplesMissing": "这些日期附近没有采集到酒店价格，酒店价格维度已排除。运行该城市的采集任务即可覆盖。",
  "warning.hotelJustCollected": "该目的地此前没有酒店价格，本次请求已即时采集，酒店分数来自这次采集结果。",
  "warning.hotelCollectionBudget": "该目的地的酒店价格暂时无法采集：今日采集额度已用完，之后的请求会自动补采。",
  "warning.hotelCollectionFailed": "该目的地酒店价格采集失败，酒店维度已排除，具体原因见服务端日志。",
  "warning.hotelDataIsStale": "已采集的酒店价格距今已有数月，参考价格可能已经变化。",
  "warning.holidaySourceIncomplete": "该时段的公共假期日历未能完整获取，拥挤度仅基于周末估算。",
  "warning.fxFromStaticTable": "该货币对不在欧洲央行公布范围内，汇率来自静态参考表而非实时数据。",
  "dimension.weather": "天气",
  "dimension.hotel": "酒店价格",
  "dimension.flight": "机票价格",
  "dimension.crowd": "拥挤度",
  "dimension.fx": "汇率",


  "fact.basis": "数据来源",
  "fact.temp": "气温",
  "fact.humidity": "湿度",
  "fact.precip": "降水概率",
  "fact.spread": "典型波动范围",
  "fact.sampledDate": "取样日期",
  "fact.date": "取样日期",
  "fact.tempC": "气温",
  "fact.humidityPct": "湿度",
  "fact.tempSpreadC": "气温典型波动",
  "fact.humiditySpreadPct": "湿度典型波动",
  "fact.precipProbabilityPct": "降水概率",
  "fact.fareLocal": "票价（出发地货币）",
  "fact.ageHours": "报价距今（小时）",
  "fact.theoreticalUsd": "距离模型理论票价（美元）",
  "fact.historyMin": "历史最低票价",
  "fact.historyMedian": "历史中位票价",
  "fact.historyMax": "历史最高票价",
  "fact.fareToTheoreticalRatio": "票价与距离模型之比",
  "fact.unavailable": "原因",
  "fact.tripDays": "行程天数",
  "fact.holidayCount": "区间内公共假期数",
  "fact.weekendDays": "周末天数",
  "fact.holidayPressureDays": "加权假期天数",
  "fact.longestPeakRun": "最长连续高峰天数",
  "fact.from": "卖出货币",
  "fact.to": "买入货币",
  "fact.yearLow": "一年内最低",
  "fact.yearHigh": "一年内最高",
  "fact.rangePct": "波动区间宽度",
  "fact.positionInRange": "在一年区间中的位置",
  "fact.asOf": "汇率日期",
  "fact.fetchedAt": "价格更新时间",
  "fact.perNight": "每晚中位价",
  "fact.baseline": "基准价（¥500 等值）",
  "fact.index": "价格 / 基准",
  "fact.sampleSize": "有报价的酒店数",
  "fact.propertyUniverse": "该城市已知酒店数",
  "fact.disclosure": "价格披露方式",
  "fact.indexPctVsBaseline": "与 ¥500 基准的差距",
  "hotel.disclosure.price": "具体金额",
  "hotel.disclosure.index": "仅指数",
  "fact.collectedAt": "价格采集时间",
  "fact.holidayLift": "假期价格加成",
  "fact.seasonalFactor": "季节系数",
  "fact.nearbyHolidayDays": "±3 天内的假期数",
  "fact.medianNotBookable": "自行采集的中位价，非可预订房价",
  "fact.fare": "最低往返票价",
  "fact.updated": "价格更新于",
  "fact.theoretical": "按距离推算的理论票价（美元）",
  "fact.theoreticalLocal": "换算到出发地货币的理论票价",
  "fact.ratio": "实际票价 / 理论票价",
  "fact.percentile": "在该航线历史中的分位",
  "fact.historyRange": "常见价格区间",
  "fact.lookback": "回溯窗口",
  "fact.bookingOpens": "开放预订日期",
  "fact.bookingOpensOn": "开放预订日期",
  "fact.lookbackDays": "回溯窗口（天）",
  "fact.holidays": "区间内公共假期",
  "fact.holidayDates": "假期日期",
  "fact.weekends": "周末天数",
  "fact.peakRun": "最长连续假期",
  "fact.pressure": "假期压力值",
  "fact.pair": "货币对",
  "fact.rate": "当前汇率",
  "fact.yearRange": "一年区间",
  "fact.rangeWidth": "区间宽度",
  "fact.position": "区间内位置",

  "weather.basis.forecast": "预报",
  "weather.basis.climate-normal": "气候统计值（历史平均）",
  "weather.driver.tempIdeal": "接近 25℃ 理想值",
  "weather.driver.tempHot": "偏热",
  "weather.driver.tempCold": "偏冷",
  "weather.driver.humidityIdeal": "湿度接近理想值",
  "weather.driver.humidityHumid": "偏湿",
  "weather.driver.humidityDry": "偏干",
  "weather.driver.forecast": "真实预报",
  "weather.driver.climateNormal": "历史同期均值，非预报",

  "hotel.basis.collected-median": "Hotelbeds 中位房价",
  "hotel.basis.mock-flat": "示例数据（合成指数）",
  "hotel.driver.collectedMedian": "Hotelbeds 房价中位数",
  "hotel.driver.mockFlat": "合成示例数据",
  "hotel.driver.belowBaseline": "不高于每晚 ¥500",
  "hotel.driver.aboveBaseline": "高于每晚 ¥500",
  "hotel.driver.farAboveBaseline": "远高于每晚 ¥500",
  "hotel.driver.thinSample": "取样酒店偏少",
  "hotel.driver.staleSamples": "价格距今数月",
  "hotel.driver.notCollected": "尚未采集价格",
  "hotel.driver.indexOnly": "仅发布指数，不发布金额",

  "flight.basis.cached-fare": "缓存价格",
  "flight.basis.distance-model": "距离模型",
  "flight.basis.blended": "混合估算",
  "flight.driver.percentile": "对比该航线历史",
  "flight.driver.newLow": "回溯窗口内最低",
  "flight.driver.cheapVsHistory": "低于常见价",
  "flight.driver.typicalVsHistory": "常见价格",
  "flight.driver.expensiveVsHistory": "高于常见价",
  "flight.driver.distanceModel": "无历史价，按距离估算",
  "flight.driver.atOrBelowTheoretical": "不高于距离估算",
  "flight.driver.aboveTheoretical": "高于距离估算",
  "flight.driver.outsideBookingWindow": "尚未开售",
  "flight.driver.noQuote": "该日期无报价",
  "flight.driver.noFxForAnchor": "缺少汇率，无法比较",
  "flight.driver.blended": "近期票价混合",
  "flight.driver.staleQuote": "缓存价可能过期",

  "crowd.driver.noHolidays": "无公共假期",
  "crowd.driver.hasHolidays": "含公共假期",
  "crowd.driver.peakRun": "连续假期",
  "crowd.driver.weekendsCounted": "已计入周末",
  "crowd.driver.proxyOnly": "估算值，非实测客流",

  "fx.driver.flatRange": "该货币对波动极小",
  "fx.driver.nearYearHigh": "接近一年高点",
  "fx.driver.nearYearLow": "接近一年低点",
  "fx.driver.midRange": "处于一年中段",
  "fx.driver.higherIsBetter": "汇率越强，当地能换到越多",
  "fx.driver.sameCurrency": "两端同一货币",

  "warning.lowConfidenceDimensions":
    "部分维度依赖低置信度数据，总分仅供参考。",
  "warning.weatherIsClimateNormal":
    "天气使用的是历史平均值而非预报，距今这么远无法预测具体某一天。",
  "warning.hotelIsMock": "酒店价格为合成示例数据，尚未采集房价数据集。",
  "warning.flightUnavailable":
    "该日期没有可用票价，因此机票维度被排除在总分之外，而不是记为 0 分。",
  "warning.flightNotCachedFare":
    "该航线暂无历史价格，机票分改由距离模型估算。",
  "warning.totalCappedByWeakDimension": "某个维度得分过低，总分已被限制。",
  "warning.sameCurrency": "出发地与目的地使用同一货币，汇率维度已排除。",
  "warning.holidayCoverageIncomplete":
    "假期数据未覆盖该区间的全部年份，拥挤度可能被低估。",

  "footer.disclaimer":
    "天气、假期、汇率与酒店房价在配置了数据源时均为实时数据；未配置的维度会明确标注为示例数据。",
  "footer.language": "语言",

  "time.justNow": "刚刚",
  "time.hoursAgo": "{hours} 小时前",
  "time.daysAgo": "{days} 天前",
};

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = {
  en,
  zh,
};

/** Replaces {placeholders}. Missing keys fall back to the key itself, loudly. */
export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const table = MESSAGES[locale] as Record<string, string>;
  const fallback = MESSAGES[DEFAULT_LOCALE] as Record<string, string>;
  let template = table[key] ?? fallback[key];
  if (template === undefined) return key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      template = template.replaceAll(`{${name}}`, String(value));
    }
  }
  return template;
}

export function createTranslator(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
}

export type Translator = ReturnType<typeof createTranslator>;

/** Locale used for `Intl` number and date formatting. */
export function intlLocale(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}
