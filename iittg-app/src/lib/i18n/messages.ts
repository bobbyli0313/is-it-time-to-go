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
    "One score for whether now is a good time to take that trip — built from weather, prices, crowding and exchange rates.",

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
  "form.selectCity": "Select a city",
  "form.swap": "Swap origin and destination",
  "form.tripLength": "{days} days",
  "form.routeUnavailable": "No data for this city pair yet",
  "form.dateRange": "Departure must be between today and 30 days from today",
  "form.returnBeforeDepart": "Return date must be on or after the departure date",

  "result.heading": "Your trip score",
  "result.outOf": "out of 100",
  "result.arithmeticComparison": "Simple average of the five dimensions",
  "result.days": "{days}-day trip",
  "result.attributionHeading": "What is costing you points",
  "result.attributionNone": "Nothing is dragging this trip down.",
  "result.pointsLost": "{points} pts",
  "result.factDetails": "Data details",
  "result.bothAverages":
    "This total is a weighted power mean, not a plain average: it deliberately punishes a single bad dimension rather than letting four good ones hide it.",
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
  "warning.hotelDataIsStale": "The collected hotel prices are several months old, so the reference price may have moved.",
  "warning.holidaySourceIncomplete": "The public holiday calendar for this period could not be fully retrieved, so the crowding estimate is based on weekends only.",
  "warning.fxFromStaticTable": "This currency pair is outside the ECB's published basket, so the exchange rate comes from a static reference table rather than a live feed.",
  "dimension.weather": "Weather",
  "dimension.hotel": "Hotel prices",
  "dimension.flight": "Flight prices",
  "dimension.crowd": "Crowding",
  "dimension.fx": "Exchange rate",

  "confidence.high": "High confidence",
  "confidence.medium": "Medium confidence",
  "confidence.low": "Low confidence",
  "confidence.notApplicable": "Not applicable",

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
  "weather.driver.tempIdeal": "Temperature is close to the 25 °C ideal",
  "weather.driver.tempHot": "Hotter than the 25 °C ideal",
  "weather.driver.tempCold": "Colder than the 25 °C ideal",
  "weather.driver.humidityIdeal": "Humidity is close to the 50% ideal",
  "weather.driver.humidityHumid": "More humid than the 50% ideal",
  "weather.driver.humidityDry": "Drier than the 50% ideal",
  "weather.driver.forecast": "Based on an actual forecast",
  "weather.driver.climateNormal":
    "Too far ahead for a forecast — this is a historical average for the month",

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
  "hotel.driver.collectedMedian":
    "Scored on the median nightly rate Hotelbeds returns for this city",
  "hotel.driver.mockFlat":
    "Synthetic sample data — run the collector for this city to replace it",
  "hotel.driver.belowBaseline": "At or below the baseline nightly rate",
  "hotel.driver.aboveBaseline": "Above the baseline nightly rate",
  "hotel.driver.farAboveBaseline": "Well above the baseline nightly rate",
  "hotel.driver.thinSample": "Few properties behind this median",
  "hotel.driver.staleSamples": "The collected prices are months old",
  "hotel.driver.notCollected":
    "No hotel prices have been collected for this destination",
  "hotel.driver.indexOnly":
    "This source permits publishing the distance from the anchor, not the price itself",

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
  "flight.driver.percentile": "Scored against this route's own fare history",
  "flight.driver.newLow":
    "Cheapest this route has been in the lookback window",
  "flight.driver.cheapVsHistory": "Below the usual price for this route",
  "flight.driver.typicalVsHistory": "Typical price for this route",
  "flight.driver.expensiveVsHistory": "Above the usual price for this route",
  "flight.driver.distanceModel":
    "No fare history yet, so this is scored against the distance model",
  "flight.driver.atOrBelowTheoretical":
    "At or below the distance-based theoretical fare",
  "flight.driver.aboveTheoretical": "Above the distance-based theoretical fare",
  "flight.driver.outsideBookingWindow":
    "Airlines have not opened bookings for these dates yet",
  "flight.driver.noQuote": "No fare available for these dates",
  "flight.driver.noFxForAnchor": "No exchange rate was available to compare this fare against the distance-based reference",
  "flight.driver.blended": "Blended from recent fares",
  "flight.driver.staleQuote": "This cached fare may be out of date",

  "fact.holidays": "Public holidays in range",
  "fact.holidayDates": "Holiday dates",
  "fact.weekends": "Weekend days",
  "fact.peakRun": "Longest consecutive holiday run",
  "fact.pressure": "Holiday pressure",
  "crowd.driver.noHolidays": "No public holidays during your trip",
  "crowd.driver.hasHolidays": "Public holidays fall inside your trip",
  "crowd.driver.peakRun":
    "Several consecutive holidays — expect the busiest conditions",
  "crowd.driver.weekendsCounted": "Weekends are counted into this estimate",
  "crowd.driver.proxyOnly":
    "An estimate from holidays and weekends — not measured visitor numbers",

  "fact.pair": "Currency pair",
  "fact.rate": "Current rate",
  "fact.yearRange": "12-month range",
  "fact.rangeWidth": "Range width",
  "fact.position": "Position in range",
  "fx.driver.flatRange": "This pair barely moves, so the rate matters little",
  "fx.driver.nearYearHigh":
    "Near the strongest this currency has been in a year",
  "fx.driver.nearYearLow": "Near the weakest this currency has been in a year",
  "fx.driver.midRange": "Mid-range for the past year",
  "fx.driver.higherIsBetter":
    "A stronger rate means your money buys more when you arrive",
  "fx.driver.sameCurrency": "Same currency at both ends — not applicable",

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
    "用天气、价格、拥挤度和汇率，为「现在适不适合去」给出一个分数。",

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
  "form.selectCity": "选择城市",
  "form.swap": "交换出发地与目的地",
  "form.tripLength": "{days} 天",
  "form.routeUnavailable": "暂不支持该城市组合",
  "form.dateRange": "出发日期需在今天至 30 天之内",
  "form.returnBeforeDepart": "返回日期不能早于出发日期",

  "result.heading": "本次旅行得分",
  "result.outOf": "满分 100",
  "result.arithmeticComparison": "五个维度的简单平均分",
  "result.days": "{days} 天行程",
  "result.attributionHeading": "扣分来自哪里",
  "result.attributionNone": "没有明显拖累这次旅行的因素。",
  "result.pointsLost": "{points} 分",
  "result.factDetails": "数据明细",
  "result.bothAverages":
    "总分为加权幂平均而非简单平均：这是有意为之，避免四个高分掩盖一个致命短板。",
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
  "warning.hotelDataIsStale": "已采集的酒店价格距今已有数月，参考价格可能已经变化。",
  "warning.holidaySourceIncomplete": "该时段的公共假期日历未能完整获取，拥挤度仅基于周末估算。",
  "warning.fxFromStaticTable": "该货币对不在欧洲央行公布范围内，汇率来自静态参考表而非实时数据。",
  "dimension.weather": "天气",
  "dimension.hotel": "酒店价格",
  "dimension.flight": "机票价格",
  "dimension.crowd": "拥挤度",
  "dimension.fx": "汇率",

  "confidence.high": "置信度高",
  "confidence.medium": "置信度中",
  "confidence.low": "置信度低",
  "confidence.notApplicable": "不适用",

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
  "weather.driver.tempIdeal": "气温接近 25℃ 的理想值",
  "weather.driver.tempHot": "比 25℃ 的理想值偏热",
  "weather.driver.tempCold": "比 25℃ 的理想值偏冷",
  "weather.driver.humidityIdeal": "湿度接近 50% 的理想值",
  "weather.driver.humidityHumid": "比 50% 的理想值偏湿",
  "weather.driver.humidityDry": "比 50% 的理想值偏干",
  "weather.driver.forecast": "基于真实天气预报",
  "weather.driver.climateNormal":
    "距今太远无法预报，此处为当月历史平均值",

  "hotel.basis.collected-median": "Hotelbeds 中位房价",
  "hotel.basis.mock-flat": "示例数据（合成指数）",
  "hotel.driver.collectedMedian": "按 Hotelbeds 返回的该城市每晚房价中位数评分",
  "hotel.driver.mockFlat": "当前为合成示例数据，运行该城市采集任务即可替换",
  "hotel.driver.belowBaseline": "不高于基准每晚价格",
  "hotel.driver.aboveBaseline": "高于基准每晚价格",
  "hotel.driver.farAboveBaseline": "远高于基准每晚价格",
  "hotel.driver.thinSample": "支撑该中位价的酒店数量偏少",
  "hotel.driver.staleSamples": "已采集的价格距今已有数月",
  "hotel.driver.notCollected": "该目的地尚未采集酒店价格",
  "hotel.driver.indexOnly": "该数据源只允许发布与基准的差距，不允许发布具体价格",

  "flight.basis.cached-fare": "缓存价格",
  "flight.basis.distance-model": "距离模型",
  "flight.basis.blended": "混合估算",
  "flight.driver.percentile": "按该航线自身的历史价格评分",
  "flight.driver.newLow": "回溯窗口内该航线的最低价",
  "flight.driver.cheapVsHistory": "低于该航线的常见价格",
  "flight.driver.typicalVsHistory": "该航线的常见价格水平",
  "flight.driver.expensiveVsHistory": "高于该航线的常见价格",
  "flight.driver.distanceModel": "暂无历史价格，改用距离模型评分",
  "flight.driver.atOrBelowTheoretical": "不高于按距离推算的理论票价",
  "flight.driver.aboveTheoretical": "高于按距离推算的理论票价",
  "flight.driver.outsideBookingWindow": "该日期航司尚未开放预订",
  "flight.driver.noQuote": "该日期暂无可用报价",
  "flight.driver.noFxForAnchor": "缺少汇率，无法将该票价与距离推算的参考价比较",
  "flight.driver.blended": "由近期价格混合估算",
  "flight.driver.staleQuote": "该缓存价格可能已过期",

  "crowd.driver.noHolidays": "行程内没有公共假期",
  "crowd.driver.hasHolidays": "行程内包含公共假期",
  "crowd.driver.peakRun": "连续多天假期，预计最为拥挤",
  "crowd.driver.weekendsCounted": "该估算已计入周末",
  "crowd.driver.proxyOnly": "基于假期与周末的估算，并非实测客流",

  "fx.driver.flatRange": "该货币对波动极小，汇率影响有限",
  "fx.driver.nearYearHigh": "接近一年来最强水平",
  "fx.driver.nearYearLow": "接近一年来最弱水平",
  "fx.driver.midRange": "处于一年区间的中间位置",
  "fx.driver.higherIsBetter": "汇率越强，你的钱在当地能换到越多",
  "fx.driver.sameCurrency": "两端使用同一货币，不适用",

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
