# Is It Time To Go?

> 用真实数据，为「现在适不适合去」给出一个分数。
>
> One score for when is the good time for your trip, built from real time data.

Pick an origin and a destination by IATA code, choose your dates, and get a 1–100 score
for that specific trip. Behind the number are five dimensions — weather, hotel prices,
flight prices, crowding and exchange rate — each one scored on its own, each one
labelled with where its data came from, and all of them visible in the result rather
than hidden behind the total.

The point is not to predict the future. It is to make "is now a good time?" answerable
with numbers you can inspect, including the ones that argue against going.

```
$ npm test
Test Files  16 passed (16)
     Tests  287 passed (287)
```

---

## What the score is made of

| # | Dimension | What it measures | Source | Needs a key? |
|---|---|---|---|---|
| a | Weather | Distance from 25 °C / 50% humidity | [Open-Meteo](https://open-meteo.com) — 16-day forecast; monthly climate normals beyond | no |
| b | Hotel prices | Median nightly rate across the city's hotels, vs the ¥500 anchor | [Hotelbeds](https://developer.hotelbeds.com) APItude | yes |
| c | Flight prices | Percentile within the route's own fare history | [Ignav](https://ignav.com) | yes |
| d | Crowding | Public holidays and weekends inside your dates | [Nager.Date](https://date.nager.at) + a curated peak-period table | no |
| e | Exchange rate | Position within the pair's own 12-month range | [Frankfurter](https://frankfurter.dev) (ECB reference rates) | no |

Three of the five run live with no configuration at all. The other two need credentials,
and a dimension without a usable source is **excluded from the total, never scored as
zero** — a fare the airline has not put on sale is not a cheap fare, and a city whose
hotel prices have not been collected is not a cheap city.

**35 cities, 57 IATA codes, 23 countries** — the launch scope (China, Japan, Korea,
South-East Asia) plus the major long-haul hubs: London, Paris, Frankfurt, Amsterdam,
Madrid, Rome, Istanbul, New York, Los Angeles, San Francisco, Toronto, Dubai, Delhi,
Sydney. Anything else is answered with "that city isn't supported yet" rather than
resolved to a nearest match.

---

## Run it

```bash
cd iittg-app
npm install
npm run dev        # http://localhost:3000
```

Weather, holidays and FX are live out of the box. To enable the other two, copy
`.env.example` to `.env.local`:

```bash
npm run crawl:hotels -- --cities tokyo,osaka --dates 2026-10-20   # writes data/hotel-prices.json

npm test           # 287 tests, offline — no test touches the network
npm run typecheck
npm run lint
npm run build
```

With a Hotelbeds key set, that collection step is optional: a request for a city with no
fresh prices **collects them itself**, within a per-day request budget. Without a key it
simply reports the hotel dimension as unavailable and says why.

---

## How it works

```
browser
  └── POST /api/score                     src/app/api/score/route.ts
        resolves the IATA codes, validates, scores, returns provenance
          └── lib/data                     provider composition, per dimension
                ├── live/                  Open-Meteo · Nager.Date · Frankfurter · Ignav
                ├── collect/               the hotel price collector
                │     ├── adapters/        Hotelbeds (+ a configurable JSON source)
                │     ├── on-demand.ts     request-path collection, budgeted
                │     └── robots/http/…    politeness: robots.txt, pacing, budget
                ├── hotel-price.ts         the city median, and its disclosure rules
                ├── cache.ts               TTL cache: memory + disk, single-flight
                └── http.ts                timeouts, bounded retries, IPv4 preference
          └── lib/scoring                  pure functions, no I/O
```

Scoring runs server-side for three reasons: **API keys** must not reach the browser,
**caching** only works if there is one place to keep it (one scored trip is 4–6 upstream
calls), and the same call must not exist twice.

A real response, trimmed:

```jsonc
{
  "ok": true,
  "result": {
    "total": 60,
    "cappedBy": "flight",
    "dimensions": [
      { "key": "hotel", "score": 42.1, "confidence": "medium",
        "facts": { "basis": "collected-median", "disclosure": "index",
                   "indexPctVsBaseline": 242.5, "sampleSize": 101 },
        "drivers": ["hotel.driver.collectedMedian", "hotel.driver.farAboveBaseline"] },
      { "key": "crowd", "score": 99.1 }
    ],
    "attribution": [ { "key": "flight", "pointsLost": 12 },
                     { "key": "hotel", "pointsLost": 11.6 } ]
  },
  "provenance": { "weather": "live-open-meteo", "hotel": "collected-hotelbeds",
                  "flight": "live-ignav", "holidays": "live-nager-date", "fx": "live-ecb" }
}
```

---

## Decisions worth the words

Most of this repository is comments explaining *why*, because the interesting parts were
not the code. Four of them:

**Flights are scored on percentile, not distance.** The brief's `miles × $0.10` anchor
assumes price follows distance. It does not: PVG–HND is expensive per mile because it is
a slot-constrained business trunk, while CAN–BKK is cheap per mile because low-cost
carriers flood it. Scoring by distance would mark every short trunk route as bad value
forever. The distance model survives as a labelled fallback when no history exists.

**Hotel prices come from one aggregator, and disclose what they may publish.** Fourteen
hotel groups' own sites were probed before this was written: **none** served rates to an
anonymous client — some forbid the rate path in `robots.txt` outright, the rest refuse
anonymous clients at the edge — and a single chain could not answer the question anyway,
since its portfolio is not a city. Prices come from
Hotelbeds, whose one availability call returns every hotel around a point. Its `net` rate
is a *wholesale* cost, so the dataset carries a **disclosure** flag: in `index` mode the
API returns the distance from the anchor ("+242.5%") and withholds the amount, the
baseline *and* the ratio, because ratio × ¥500 would recover the price. That branch lives
in the scorer, not in a component — the response is what the browser receives.

**The reference price is a median of medians.** Each property is reduced to its own
median before the city median is taken, so a hotel sampled on twenty nights cannot
outweigh one sampled once; pooling samples would make the figure a median over
*collection effort*. Coverage is disclosed only when a property list really enumerates a
universe, a city below eight priced properties is excluded, and confidence is capped
below the "high" band because a collected median is one room type per property — not a
survey.

**Collection is bounded on the request path.** The evaluation key allows 50 requests a
day, so the collector spends them under four rules: a freshness window (a city collected
today is not collected again), a per-day counter that survives restarts, one request per
city-night with `robots.txt` cached per process, and the rule that nothing in the
collection path can fail a score. A destination with no price says which case it is in —
never collected, out of budget, or refused by the source.

---

## Two things this repository is careful about

**Provenance is part of the data, not a UI afterthought.** A weather sample *is* a
forecast or *is* a climate normal — a discriminated union, so the compiler refuses to let
a 45-day-out historical average be treated as a prediction. Same for cached fares,
collected medians and synthetic sample data. The API returns a `provenance` record and
the UI renders it, so "which of these numbers are real?" is always answerable.

**Nothing is silently invented, and nothing is silently dropped.** Every upstream
failure is a named reason (`refused by robots.txt: Disallow: /search/result/`,
`blocked by Akamai`, `no FX rate for this currency`), every discarded sample carries its
reason in the run report, and a dimension with no data is excluded rather than guessed.

The scoring model, every constant in it, and its calibration against the original brief
are specified in **[MODEL.md](iittg-app/MODEL.md)**. The app's own README —
**[iittg-app/README.md](iittg-app/README.md)** — covers the data layer and deployment in
more detail.

---

## Repository layout

```
iittg-app/
  src/app/            Next.js App Router: the page and POST /api/score
  src/components/     the form, the score card, the dimension cards
  src/lib/scoring/    the model: pure functions, no I/O, fully unit-tested
  src/lib/data/       providers, caching, the collector
  src/lib/i18n/       English + Chinese, with the language in the URL
  scripts/            the collector CLI (`npm run crawl:hotels`)
  examples/           input formats, and a source-config template
  MODEL.md            the scoring specification
```

Language lives in the URL (`?lang=zh`), so a scored trip is shareable in the recipient's
language.

---

## Status

A working prototype with real data, not a launched product. What is missing is written
down rather than implied: flight pricing is verified against live responses but its route
history is still being built, hotel coverage depends on which cities have been collected,
and the model has no price prediction — it says what prices are relative to history,
never whether waiting would help.

No licence has been chosen yet, so the code is not licensed for reuse. The API keys in
`.env.local` are the operator's own, and each source's terms govern what may be stored,
displayed and redistributed.
