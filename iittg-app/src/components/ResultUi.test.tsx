/**
 * Locks in what the result UI must *not* say.
 *
 * Every assertion here corresponds to something that was on screen and should not be
 * again. They are worth a test rather than a comment because all of them were easy to
 * reintroduce by accident:
 *
 *  - the raw key `result.detailsHeading` was rendered as a heading, because the
 *    component named a key that no dictionary had (the translator falls back to the
 *    key rather than throwing);
 *  - the arithmetic mean, the attribution chip beside the reset button, and the
 *    confidence badges were each deliberate removals — "put it back" is a one-line
 *    change someone might make without knowing why they went;
 *  - the warning list grew one line per data problem, which is how a real caveat gets
 *    lost in noise.
 *
 * `messages.test.ts` guards the dictionary side of the same contract.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScoreCard, pickNotice } from "@/components/ScoreCard";
import { DimensionCard } from "@/components/DimensionCard";
import { createTranslator } from "@/lib/i18n";
import type { DimensionScore, ScoreResult } from "@/lib/scoring/types";

const t = createTranslator("zh");

function dimension(overrides: Partial<DimensionScore> = {}): DimensionScore {
  return {
    key: "weather",
    score: 82,
    applicable: true,
    confidence: "medium",
    weight: 0.2,
    facts: { basis: "forecast", tempC: 24 },
    drivers: ["weather.driver.tempIdeal", "weather.driver.forecast"],
    ...overrides,
  };
}

function result(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    total: 74,
    arithmeticMean: 71,
    cappedBy: null,
    dimensions: [dimension()],
    attribution: [
      { key: "flight", pointsLost: 9.4 },
      { key: "fx", pointsLost: 3.1 },
    ],
    warnings: [],
    tripDays: 5,
    ...overrides,
  };
}

function renderCard(overrides: Partial<Parameters<typeof ScoreCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <ScoreCard
      result={result()}
      routeLabel="上海 → 东京"
      dateLabel="10月20日"
      dataNotes={[]}
      provenance={{
        weather: "live-open-meteo",
        holidays: "live-nager-date",
        fx: "live-ecb",
        flight: "live-ignav",
        hotel: "collected-hotelbeds",
      }}
      locale="zh"
      t={t}
      onReset={() => {}}
      {...overrides}
    />,
  );
}

describe("ScoreCard", () => {
  it("does not render a heading for a key that was never in the dictionary", () => {
    // The literal symptom users saw: the raw key, as a heading.
    expect(renderCard()).not.toContain("result.detailsHeading");
  });

  it("does not show the simple average of the dimensions", () => {
    const html = renderCard();
    expect(html).not.toContain("简单平均");
    // The number itself must not leak back in either.
    expect(html).not.toContain("71");
  });

  it("keeps the reset button but not the attribution chip beside it", () => {
    const html = renderCard();
    expect(html).toContain("重新开始");
    // The chip said "机票价格 · 9.4 分" next to the button.
    expect(html).not.toContain("9.4 分");
  });

  it("shows only the single most important notice", () => {
    const html = renderCard({
      result: result({
        warnings: [
          "warning.weatherIsClimateNormal",
          "warning.flightUnavailable",
          "warning.fxFromStaticTable",
        ],
      }),
      dataNotes: ["warning.holidayCoverageSpanningYears"],
    });

    // A missing flight dimension outranks a climate normal, a static FX table and a
    // year-boundary note.
    expect(html).toContain(t("warning.flightUnavailable"));
    for (const quieter of [
      "warning.weatherIsClimateNormal",
      "warning.fxFromStaticTable",
      "warning.holidayCoverageSpanningYears",
    ]) {
      expect(html).not.toContain(t(quieter));
    }
    // Exactly one warning glyph, however many warnings arrived.
    expect(html.split("⚠").length - 1).toBe(1);
  });

  it("says nothing when every warning is one the cards already state", () => {
    const html = renderCard({
      result: result({
        warnings: [
          "warning.sameCurrency",
          "warning.lowConfidenceDimensions",
          "warning.totalCappedByWeakDimension",
          "warning.flightNotCachedFare",
          "warning.hotelJustCollected",
        ],
      }),
    });
    expect(html).not.toContain("⚠");
  });

  it("carries the entrance animation", () => {
    expect(renderCard()).toContain("animate-rise");
  });
});

describe("pickNotice", () => {
  it("ignores keys that are not on the list, including informational ones", () => {
    expect(pickNotice(["warning.hotelJustCollected"])).toBeNull();
    expect(pickNotice(["warning.sameCurrency", "warning.hotelDataIsStale"])).toBe(
      "warning.hotelDataIsStale",
    );
  });

  it("returns the highest-priority key regardless of order", () => {
    expect(
      pickNotice(["warning.hotelSamplesMissing", "warning.flightUnavailable"]),
    ).toBe("warning.flightUnavailable");
  });
});

describe("DimensionCard", () => {
  const render = (d: DimensionScore, index = 0) =>
    renderToStaticMarkup(
      <DimensionCard dimension={d} index={index} locale="zh" t={t} />,
    );

  it("does not show a confidence badge", () => {
    const html = render(dimension({ confidence: "high" }));
    for (const label of ["置信度高", "置信度中", "置信度低", "不适用"]) {
      expect(html).not.toContain(label);
    }
  });

  it("still says not-applicable with a dash rather than a number", () => {
    const html = render(
      dimension({ score: null, applicable: false, drivers: ["fx.driver.sameCurrency"] }),
    );
    expect(html).toContain("—");
  });

  it("staggers its entrance and grows its bar", () => {
    const html = render(dimension(), 3);
    expect(html).toContain("animate-rise");
    expect(html).toContain("animation-delay:180ms");
    expect(html).toContain("bar-grow");
  });
});
