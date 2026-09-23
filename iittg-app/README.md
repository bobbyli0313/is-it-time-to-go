# IITTG — Is It Time To Go?

Travel decision scoring prototype. Answers one question: **is now a good time to
go?** — with a 1–100 score built from weather, hotel prices, flight prices,
crowding and exchange rates.

This is **step 1 of the plan: the prototype, with mock data.** It does not call
any external API and does not need a database. The point is to settle the scoring
model with real users before spending months integrating data sources.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

Other scripts:

```bash
npm test             # 82 tests: model, i18n contract, data pipeline, layout contract
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run build        # production build
```

> If `npm install` fails with `EPERM` on `~/.npm/_cacache`, point npm at a local
> cache: `npm_config_cache=./.npm-cache npm install`.

## What works

- English and Chinese, switchable, with the choice encoded in the URL so a scored
  trip is shareable in the recipient's language.
- 21 cities across China, Japan, Korea and Southeast Asia; 60 route pairs;
  143 holiday entries covering 11 countries for 2026–2027.
- Departure dates from today to today + 30, trips of 1–30 days.
- A score with per-dimension breakdown, confidence badges, a "what is costing you
  points" attribution list, and an expandable panel showing the raw data behind
  every dimension.

Try a shared link:

```
/?lang=zh&from=shanghai&to=tokyo&depart=<a date within 30 days>&return=<4 days later>
```

## What is deliberately fake

Every data source is mocked, and the mock data is built to behave like the real
thing — including its limitations, so the UI is honest from day one:

| Dimension | Mock behaviour | Why it matters |
|---|---|---|
| Weather | A real forecast inside 14 days; a tagged climate normal beyond it | Numeric forecasts do not exist at 40 days out |
| Hotel | A normalised price *index*, never a bookable rate | No public API exposes central-hotel averages |
| Flight | Cached fares with a real age; unavailable past ~330 days | Live fares need enterprise contracts |
| Crowding | Holiday calendar plus a weekend term | Foot traffic has no public API |
| FX | Reference levels against CNY | Position within the pair's own 12-month range |

## Layout

```
src/
  app/                  server component: parses the query string
  components/           ScoreApp, TripForm, ScoreCard, DimensionCard, DimensionGrid,
                        LanguageSwitcher
  lib/
    scoring/            the model — pure functions, no I/O
      types.ts          domain model; provenance-carrying unions
      dates.ts          timezone-explicit calendar arithmetic
      dimensions.ts     the five scorers, all constants in PARAMS
      index.ts          scoring entry point + aggregation
    data/               the mock provider — the API seam
      provider.ts       async functions the scoring layer consumes
      cities.ts, routes.ts, holidays.ts, reference.ts, seed.ts
    i18n/               en + zh dictionaries, keyed by flat namespaced strings
    format.ts           presentation formatting
    requestScore.ts     the single call the UI makes
```

## Two design rules that shaped everything

**1. Provenance is part of the data, not a UI afterthought.**
A weather sample *is* a forecast or *is* a climate normal — that is a
discriminated union, so the compiler refuses to let a 45-day-out historical
average be treated as a prediction. Same for cached fares, and for hotel indices.
Confidence badges are derived from provenance, not from how pleasant the number
looks.

**2. The scoring layer never emits prose.**
It emits i18n keys in `drivers`. `src/lib/i18n/messages.test.ts` walks every
scorer across every branch and asserts each emitted key resolves in both locales,
so a typo cannot silently ship a raw key to a user.

## Next steps

The scoring model, not the data sources, is where the remaining risk is. See
`MODEL.md` for the full specification, the calibration of every constant, and the
list of what is still undecided.

To integrate real APIs, reimplement the five functions in
`src/lib/data/provider.ts` and nothing else — no scorer, component or test needs
to change. Move `requestScore` server-side at the same time, so API keys never
reach the client and results can be cached in Redis keyed by
`(origin, destination, dateRange)`. **That cache is a hard requirement, not an
optimisation:** one scored trip is 4–6 upstream calls, so without it the free
tiers are exhausted in a day.
