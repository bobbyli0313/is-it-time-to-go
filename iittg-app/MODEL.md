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
| Hotel | closer to ¥500/night is better, ≤¥500 is full marks | 70 at ¥1000 | no formula given | 70 — decay fitted to the example, on a collected median |
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
ratio  = perNightLocal / baselineLocal          (baseline = ¥500, converted)
hotel  = 100 · exp(−0.356675 · max(0, ratio − 1)),  floored at 5
```

The decay constant is fitted so that a price of exactly 2× baseline scores 70 — the
only hotel data point the brief provides. Behaviour: 1× → 100, 1.5× → ~84, 2× → 70,
3× → ~49, 4× → ~34.

### What `perNightLocal` is

**The median nightly rate across a city's collected hotels**, comparing like with
like:

```
per property:   median of that property's prices in the ±3-day window
                (verified extractions preferred over inferred ones)
per city:       median of the per-property medians
published when: at least 8 properties have prices
```

Three rules do the real work, and each exists because of a specific way the number
could otherwise mislead:

- **One property, one vote.** Pooling every sample would weight the median by
  collection effort: a hotel sampled on twenty nights would decide the city's price on
  its own. Reducing each property to its own median first is what makes "the median of
  the hotels" true.
- **Coverage is disclosed, and scoped.** `sampleSize` is how many properties are
  behind the number; `propertyUniverse` is how many the census knows. A census that
  enumerates one chain is reported as `censusScope: "chain"`, not as the city — a
  chain's business hotels sit below the city's average, so the same numbers carry a
  confidence penalty when the census is chain-scoped.
- **Age is disclosed.** Samples older than 45 days set `stale`, which cuts confidence
  and adds a driver, because a level collected months ago is a claim about a past
  market.

Confidence combines breadth, dispersion (IQR ÷ median), coverage, the share of
inferred extractions, staleness and scope, and is **capped at 0.62** — below the
scorer's 0.66 "high" threshold, on purpose. A collected median is one room type per
property, not a survey.

### Disclosure: the amount, or the distance from ¥500

A source may permit storing a rate but not republishing it — Hotelbeds' `net` is a
wholesale cost, and its agreement governs what may be shown. So a dataset carries
`disclosure`:

```
disclosure = "price"   →  facts: { perNight, baseline, index, … }
disclosure = "index"   →  facts: { indexPctVsBaseline, disclosure: "index", … }
```

The score is identical either way — it only ever needed the ratio. What changes is what
leaves the server. The branch lives in `scoreHotel` rather than in a component because
`facts` becomes the API response: hiding a field in the UI would leave it in the JSON.
In index mode the ratio is withheld too, since ratio × ¥500 recovers the price.

**Below eight priced properties the dimension is excluded, not scored low.** A
missing price is not a cheap one, and the same rule already governs unavailable fares.

### Why it is collected rather than fetched

The collector in `src/lib/data/collect/` reads prices from **Hotelbeds** — an
inventory aggregator whose one availability call returns every hotel around a city
centre, across chains, which is the breadth a city median needs. It obeys robots.txt,
paces itself, and can also read a file via `--import` for prices collected elsewhere.
The mock provider returns a synthetic index with its drivers disclosed separately
(`holidayLift`, `seasonal`, `cityLevel`) and labels its basis `mock-flat`, so it can
never be mistaken for collected data.

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

---

## Data sources feeding this model

Where each dimension's numbers actually come from, as of the live integration. The
UI states this per dimension; a partially-live deployment must not look fully live.

| Dimension | Source | Confidence is capped by |
|---|---|---|
| Weather | Open-Meteo. Forecast inside 16 days; a **monthly** climate normal beyond it | Provenance: a normal can never be high confidence |
| Hotel | A median over prices this app collects itself (synthetic index in the mock) | Property count, coverage and scope, and the age of the samples |
| Flight | Amadeus cached fares (mock until keys exist), percentile within route history | History depth; quote age beyond 24h |
| Crowding | Nager.Date holidays + a curated peak-period table + a weekend term | It is a proxy, and never claims otherwise |
| FX | ECB daily reference rates, 12-month range measured from real observations | Pair volatility; static fallback for TWD/VND |

### Three source-driven decisions worth recording

**Climate normals are monthly, not daily.** The first implementation keyed them per
calendar day, which meant a trip spanning a month boundary pulled several
Open-Meteo archive responses at 7–10 seconds each, and every distinct day cost its
own fetch. A month is 30× fewer cache keys for a difference in accuracy that sits
well inside the noise the model already discloses — a normal is capped at medium
confidence precisely because it cannot speak to a specific day.

**Peak holiday periods are curated, not inferred.** Nager.Date reports every holiday
as `Public`, so a single bank holiday and Japan's Golden Week arrive identically.
Clustering consecutive holidays was tried and rejected: it works for Golden Week but
is wrong for Chinese New Year and Obon — and Obon is not statutory in Japan, so the
source does not list it at all. The source is therefore used for coverage and a
narrow curated table supplies intensity. The `additive` flag on a period means "these
are travel days the source does not list" rather than "re-weight days the source
already reports", which is what stops the table from fabricating holidays: in 2026,
3 May is a Sunday and the observed substitute is 6 May, so 1–3 May are added as a
travel *period* rather than claimed as public holidays.

**FX is normalised inside the pair's own 12-month range**, measured from real daily
observations rather than assumed. This is what makes a volatile pair (CNY/JPY) and a
managed one (CNY/HKD) comparable — and the latter is detected as effectively flat and
scored neutrally at low confidence rather than treated as if its 0.9% annual drift
were a signal.

### What the live data changed about the model

Nothing in the five scorers' arithmetic: every constant in `PARAMS` is untouched,
which was the point of building the model against mock data that reproduced the real
sources' limitations first. What changed is the *inputs*: `basis` now genuinely varies
(forecast vs climate normal), fares genuinely carry an age, and the FX source is
genuinely either ECB or the static table.

The one conceptual change came from the hotel side, and it was forced by the source
research rather than chosen: the reference price is a **level** (a median) rather than
a relative index, so `HotelQuote` gained `propertyUniverse`, `censusScope`,
`collectedAt` and `stale`, and the mock stopped claiming the collected basis. A level
can be compared with the ¥500 anchor directly, which is what the brief always asked
for — but it also has to disclose how much of a city it saw, which an index normalised
against a city's own baseline never had to.

## What is still undecided

- **Weights are equal.** They should probably not be. A cheap-fare-led traveller
  and a weather-led traveller want different weightings; per-user weights are the
  obvious v2.
- **Single-day weather sampling.** The brief grades a whole trip on one day.
  Scoring the full distribution would be more honest and is a small change.
- **No price prediction.** The model is purely descriptive: it says what prices
  are relative to history, never whether waiting would help. A trend or forecast
  term is the highest-value addition once real history exists.
- **Hotel breadth.** The median is only as wide as its sources. Until a city-wide
  inventory feed is wired in, a collected median is chain-scoped, and the model says
  so rather than presenting one chain's business hotels as a city's price level.
