# Example: prices collected from a source you are entitled to use

This directory holds **examples, not data**. Nothing here is a real price, and
nothing here is loaded by the app — the collector takes these shapes as input when
you point it at them.

| File | What it shows |
|---|---|
| `hotel-rates.example.csv` | The rates format: 12 Tokyo properties × 3 nights of synthetic prices. This is the format a partner API export, a licensed feed, or a browser-assisted collection has to end up in. |
| `hotel-source.template.json` | A template for `--source`: the mapping the collector needs to read some *other* JSON rate endpoint you are allowed to call. Hotelbeds is built in and needs none of this. |

## The normal path: Hotelbeds

```bash
# Free evaluation key: 50 requests/day, self-serve.
export IITTG_HOTELBEDS_API_KEY=...      # from developer.hotelbeds.com
export IITTG_HOTELBEDS_SECRET=...

node --import ./scripts/ts-loader.mjs scripts/crawl-hotel-prices.ts \
  --cities tokyo,osaka,sapporo --dates 2026-10-20,2026-10-27 \
  --out data/hotel-prices.json
```

One request per city per date returns every hotel with availability around the city
centre, so a run over three cities and two dates costs six of the day's fifty
requests. Rates are quoted in your contract currency and converted to the city's own
currency, with the conversion noted on every sample.

**Disclosure defaults to `index`** for this source: `net` is a wholesale cost under an
agreement that governs what may be shown, so the app publishes "91.6% above the ¥500
anchor" rather than the amount. Pass `--disclosure price` if your agreement allows
displaying prices — the switch is on the dataset, and it is enforced in the scorer, so
an amount the source forbids never reaches the browser.

**The response shape is verified** against a live evaluation key (2026-09-29): 101
Tokyo, 51 Osaka and 13 Sapporo hotels priced, with the per-night breakdown. The
evaluation environment has no inventory for most other Asian cities, so a run there
reports "no hotels returned availability" and excludes the city — production inventory
is a different dataset.

## Try the pipeline without collecting anything

```bash
cd iittg-app

# Build a dataset from the example prices and report the reference price.
node --import ./scripts/ts-loader.mjs scripts/crawl-hotel-prices.ts \
  --cities tokyo \
  --dates 2026-10-20 \
  --import examples/hotel-rates.example.csv \
  --out .cache/hotel-demo.json

# Look at it as the app will.
node --import ./scripts/ts-loader.mjs -e '
  const { createFileStore } = await import("./src/lib/data/hotel-dataset-file.ts");
  const store = createFileStore(".cache/hotel-demo.json", { strict: true });
  console.log(JSON.stringify((await store.load()).cities[0].properties.length));
'
```

The run prints the median it computed, the coverage it can claim, and — importantly
— every row it rejected and why. A collection run that quietly drops half its input
is worse than one that fails.

## Before you point this at a real source

1. **Check `robots.txt`.** The collector does this for you and will refuse a
   disallowed path, but you should know which answer to expect. An API host usually
   serves no robots.txt at all (Hotelbeds' answers 404), and the contract behind it —
   not the file — is what governs what you may store and publish.
2. **Check the terms of service.** robots.txt is a crawler convention, not a
   licence. Several groups' terms separately prohibit automated access and
   redistribution, and a partner contract governs what you may store and re-publish.
3. **Keep the extraction honest.** `"extraction": "verified"` means you have
   checked the response mapping against real responses. Unverified extractions are
   accepted but cost confidence in the published median, which is the model's way of
   saying it does not fully trust them.
