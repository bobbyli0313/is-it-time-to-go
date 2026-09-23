# Scoring model

The prototype's whole purpose is to settle the scoring model before any API work
begins. This document is the specification of what the model actually does, and
where it deliberately departs from the original brief.

All constants live in `src/lib/scoring/dimensions.ts` under `PARAMS`. Every scorer
is a pure function, so any number here can be changed and verified by
`npm test` without touching the UI or the data layer.

---

## Where the model deviates from the brief, and why

The brief's worked example is not internally consistent. It asserts five
dimension scores and a total, but the rules as written do not produce them:

| Dimension | Brief's rule | Brief's example | What the rule yields | What this model does |
|---|---|---|---|---|
| Weather | closer to 25 °C / 50% is better | 100 | 100 | 100 — matches |
| Hotel | closer to ¥500/night is better, ≤¥500 is full marks | 70 at ¥1000 | no formula given | 70 — decay fitted to the example |
| Flight | `miles × $0.10`, dearer scores lower | 20 | ~34 | 20 in the distance fallback, fitted |
| Crowding | more holidays scores lower | 90 with "only weekends" | 100 (no holidays) | ~98 — weekends are counted, which the same sentence implies |
| FX | closer to the 12-month high scores higher | 88 | 97 | 92.3 |

`npm test` asserts these numbers explicitly, so the disagreements are pinned down
rather than papered over.

Two structural departures were made on purpose:

1. **Flights are scored on percentile, not distance.** `miles × $0.10` assumes
   price is a function of distance. It is not: PVG–HND is expensive per mile
   because it is a slot-constrained business trunk, while CAN–BKK is cheap per
   mile because low-cost carriers flood it. Scoring by distance would mark every
   short trunk route as bad value forever. The distance model is retained as a
   fallback and shown as a cross-check.
2. **The total is a weighted power mean, not an arithmetic mean.** With a plain
   average, one catastrophic dimension is hidden by four good ones and the user
   is told a bad trip is fine. See "Aggregation" below.

---

## a. Weather

```
tempScore     = 100 · exp(−((T − 25) / 14)²)
humidityScore = 100 · exp(−((H − 50) / 30)²)
weather       = 0.6 · tempScore + 0.4 · humidityScore
```

A Gaussian rather than a linear penalty, because the annoyance of a bad climate
is not linear — 30 °C is mildly worse than 25 °C, 45 °C is unusable.

**Provenance is part of the score.** A `WeatherSample` carries `basis`:
`forecast` inside a 14-day horizon, `climate-normal` beyond it. A climate normal
is capped at medium confidence no matter how perfect its average looks, because
it is an average over many years and cannot predict a specific day.

**Known limitation, disclosed in the UI:** the brief samples a single day and
grades the whole trip on it. `debug.sampledDate` records which day that was.

## b. Hotel

```
index  = perNightLocal / baselineLocal          (baseline = ¥500, converted)
hotel  = 100 · exp(−0.356675 · max(0, index − 1)),  floored at 5
```

The decay constant is fitted so that an index of exactly 2× baseline scores 70 —
the only hotel data point the brief provides. Behaviour: 1× → 100, 1.5× → ~84,
2× → 70, 3× → ~49, 4× → ~34.

**This scores a normalised price _index_, not a bookable rate.** No public API
exposes "the average price of five central hotels", and OTA terms forbid
redistributing their prices. The mock provider returns an index with its drivers
disclosed separately (`holidayLift`, `seasonal`, `cityLevel`) so the UI can say
*why* a city is expensive rather than showing one opaque number.

## c. Flight

Percentile path, used whenever route history exists:

```
flight = 100 − (percentile / 90) · 100      (clamped to 0..100)
```

So the cheapest fare in the lookback window scores 100 and the 90th percentile
scores 0. A new low is recognised explicitly.

Distance fallback, when there is no history:

```
ratio  = fare / (roundTripMiles × 0.10)
flight = 100 · exp(−0.85 · max(0, ratio − 1)),  floored at 5
```

Fares are **cached** quotes carrying `fetchedAt`. Anything older than 24 hours is
flagged stale and has its confidence reduced, so the UI's "prices updated 3h ago"
badge is load-bearing rather than decorative.

Fares outside the airline booking window return `unavailable`, which makes the
dimension `applicable: false`. It is **excluded from the total, never scored as
zero** — a missing fare is not a bad fare.

## d. Crowding

```
pressure = Σ holidayWeight[w]      for each holiday day in the trip
         + 0.3                     for each plain weekend day
crowd    = 100 − 3 · pressure − 5 · max(0, longestPeakRun − 2)
```

`holidayWeight` is 1.5 for peak (Golden Week, Lunar New Year), 1.0 normal, 0.4
minor. A run of consecutive peak days is penalised on top of the raw count,
because a solid week off is worse than the same days scattered.

This is a **holiday proxy, not a measurement of foot traffic** — tourist arrivals
and load factors have no public API. The UI says so on every card.

## e. Exchange rate

```
range   = yearHigh − yearLow
ratio   = clamp((rate − yearLow) / range, 0, 1)
fx      = 25 + ratio · 75
```

100 at a 12-month high, 25 at a 12-month low.

Two things worth stating plainly, because both are counter-intuitive:

- **A high rate is good for the traveller.** It means one unit of origin currency
  buys more destination currency. The UI carries an explicit driver string for this.
- **Normalising inside the pair's own range matters.** A fixed percentage
  threshold would score a pegged pair like CNY/HKD differently from a volatile one
  like CNY/JPY for reasons that have nothing to do with whether today is a good
  day to go. A pair whose 12-month range is under 1.2% of its midpoint is treated
  as pegged and scored neutrally at low confidence.

Same-currency trips return `applicable: false`, so FX is excluded and the
remaining weights are redistributed.

---

## Aggregation

```
total = ( Σ wᵢ · sᵢ^0.5 )²          over applicable dimensions, Σ wᵢ = 1
```

Weights default to equal at 0.2 and are normalised over *applicable* dimensions,
so a same-currency trip averages four scores rather than diluting with a zero.

The exponent is calibrated, not guessed. A pure geometric mean (exponent → 0) was
tried first and rejected: on the brief's own example it collapses the total to 49,
because one expensive fare overwhelms four decent dimensions. The square-root mean
keeps the direction of that penalty — a lopsided trip scores below its arithmetic
mean — while staying interpretable.

A second guard sits on top:

```
if any applicable dimension ≤ 40:  total = min(total, 60)
```

`ScoreResult` returns `arithmeticMean` alongside `total`, and the UI shows both,
so the effect of aggregation is visible rather than mysterious.

## Attribution

Each dimension contributes `(100 − score) · weight` points lost, sorted
descending. This is what drives the "what is costing you points" list — the
answer to *why* the score is what it is, which is the actual product.

---

## What is still undecided

- **Weights are equal.** They should probably not be. A cheap-fare-led traveller
  and a weather-led traveller want different weightings; per-user weights are the
  obvious v2.
- **Single-day weather sampling.** The brief grades a whole trip on one day.
  Scoring the full distribution would be more honest and is a small change.
- **No price prediction.** The model is purely descriptive: it says what prices
  are relative to history, never whether waiting would help. A trend or forecast
  term is the highest-value addition once real history exists.
