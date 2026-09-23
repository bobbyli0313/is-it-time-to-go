/**
 * Geometric verification of the dimension grid layout.
 *
 * The previous two attempts at this layout were both wrong in ways that static
 * class assertions did not catch:
 *   1. A fixed 3-column grid at desktop width turned 4 cards into 3 + 1.
 *   2. A `min-width: 1024px` rule for three-across overrode the two-across rule
 *      for every card count, so 4 cards again became 3 + 1 instead of 2x2.
 *
 * Both bugs were in arithmetic — what actually fits on a line — so this test
 * checks arithmetic. It extracts the real flex-basis and gap values out of
 * `globals.css`, then runs the CSS flex-wrap line-breaking algorithm over a range
 * of viewport widths and asserts how many cards land on each line.
 *
 * This is not a substitute for looking at the page, but it does mean a CSS
 * regressions in the wrap maths fails the suite instead of only being visible to
 * someone who happens to open the right page at the right width.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);

/** Container padding and page gutters: `max-w-5xl` shell with `px-6` at sm+. */
const PAGE_MAX_WIDTH_PX = 1024; // max-w-5xl
const PAGE_PADDING_PX = 24 * 2; // px-4 -> px-6 at sm+

/** Parses `calc((100% - 2.5rem) / 3)` into a function of container width. */
function parseBasis(declaration: string): (containerPx: number) => number {
  const match = declaration.match(
    /calc\(\(100% - ([\d.]+)rem\) \/ (\d+)\)/,
  );
  if (!match) throw new Error(`Unparsed flex-basis: ${declaration}`);
  const gapRem = Number(match[1]);
  const columns = Number(match[2]);
  return (containerPx) => (containerPx - gapRem * 16) / columns;
}

/** Pulls the basis declarations for a variant out of the stylesheet. */
function basisRulesFor(variant: string) {
  const rules: Array<{ minWidth: number; basis: (px: number) => number }> = [];

  // Base rule (mobile): full width, one per line.
  rules.push({ minWidth: 0, basis: () => Number.POSITIVE_INFINITY });

  const blockRe = /@media \(min-width: (\d+)px\) \{([\s\S]*?)\n\}/g;
  for (const block of css.matchAll(blockRe)) {
    const minWidth = Number(block[1]);
    const body = block[2];
    // A rule applies if its selector list mentions the variant, or the shared
    // base selector `.dimension-grid > *`.
    const ruleRe = /([^{}]+)\{([^}]+)\}/g;
    for (const rule of body.matchAll(ruleRe)) {
      const selectors = rule[1];
      const applies =
        selectors.includes(`.${variant} > *`) ||
        selectors.trim().startsWith(".dimension-grid > *");
      if (!applies) continue;
      const basis = rule[2].match(/flex-basis:\s*([^;]+);/);
      if (basis) rules.push({ minWidth, basis: parseBasis(basis[1]) });
    }
  }

  return rules.sort((a, b) => a.minWidth - b.minWidth);
}

/** The gap in px at a given viewport width: gap-4 below 640px, sm:gap-5 above. */
function gapPx(viewport: number): number {
  return viewport >= 640 ? 20 : 16;
}

/**
 * CSS flex-wrap line breaking: items are placed one per line until the next would
 * exceed the container, then a new line starts. Items here never shrink below
 * their basis because the layout has no grow and content that fits.
 */
function linesFor(
  count: number,
  viewport: number,
  rules: Array<{ minWidth: number; basis: (px: number) => number }>,
): number[] {
  const container = Math.min(viewport, PAGE_MAX_WIDTH_PX) - PAGE_PADDING_PX;
  const gap = gapPx(viewport);
  const rule = [...rules].reverse().find((r) => viewport >= r.minWidth);
  if (!rule) throw new Error(`No basis rule for viewport ${viewport}`);
  const basis = rule.basis(container);

  const lines: number[] = [];
  let used = 0;
  let onLine = 0;
  for (let i = 0; i < count; i += 1) {
    const needed = onLine === 0 ? basis : used + gap + basis;
    if (onLine > 0 && needed > container) {
      lines.push(onLine);
      onLine = 1;
      used = basis;
    } else {
      onLine += 1;
      used = needed;
    }
  }
  if (onLine > 0) lines.push(onLine);
  return lines;
}

/** Viewports to probe: a phone, a tablet, a laptop and a wide desktop. */
const VIEWPORTS = [390, 640, 768, 1024, 1280, 1536] as const;

describe("dimension grid wrap geometry", () => {
  const twoUp = basisRulesFor("dimension-grid--two-up");
  const threeUp = basisRulesFor("dimension-grid--three-up");

  it("stacks to a single column on phones for every card count", () => {
    for (const count of [2, 3, 4, 5]) {
      const rules = count >= 5 ? threeUp : twoUp;
      expect(linesFor(count, 390, rules)).toEqual([1, 1, 1, 1, 1].slice(0, count));
    }
  });

  it("lays four cards out as 2 + 2 at tablet width and above", () => {
    for (const viewport of [640, 768, 1024, 1280, 1536]) {
      expect(linesFor(4, viewport, twoUp)).toEqual([2, 2]);
    }
  });

  it("lays five cards out as 2 + 2 + 1 at tablet width", () => {
    // Three across does not fit below 1024px, so the last row holds one card.
    for (const viewport of [640, 768]) {
      expect(linesFor(5, viewport, threeUp)).toEqual([2, 2, 1]);
    }
  });

  it("lays five cards out as 3 + 2 at desktop width", () => {
    for (const viewport of [1024, 1280, 1536]) {
      expect(linesFor(5, viewport, threeUp)).toEqual([3, 2]);
    }
  });

  it("keeps two and three cards side by side once there is room", () => {
    expect(linesFor(2, 768, twoUp)).toEqual([2]);
    expect(linesFor(3, 768, twoUp)).toEqual([2, 1]);
    expect(linesFor(3, 1280, twoUp)).toEqual([2, 1]);
  });

  /**
   * The specific regression that shipped twice: a desktop rule making the
   * four-card layout three across.
   */
  it("never puts four cards on a line of three", () => {
    for (const viewport of VIEWPORTS) {
      expect(linesFor(4, viewport, twoUp)).not.toEqual([3, 1]);
    }
  });

  /**
   * The two variants must actually differ, otherwise the 4-card case would be
   * silently using the 5-card geometry (or vice versa).
   */
  it("gives the five-card grid a distinct desktop geometry from the four-card one", () => {
    expect(linesFor(5, 1280, threeUp)).toEqual([3, 2]);
    expect(linesFor(5, 1280, twoUp)).toEqual([2, 2, 1]);
  });
});
