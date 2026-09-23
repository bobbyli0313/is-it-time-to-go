/**
 * Locks in how DimensionGrid chooses its column variant.
 *
 * The card count varies with the trip: a same-currency trip has no exchange rate
 * dimension, so it renders four cards instead of five. Five cards go three across
 * on desktop (3 + 2); four or fewer stay two across so an even count fills its row
 * completely (4 cards become a solid 2x2).
 *
 * The variant only selects which CSS rules apply — whether the cards *actually*
 * wrap into those rows is arithmetic, and is verified in `gridGeometry.test.ts`,
 * which extracts the real flex-basis values and runs the flex line-breaking
 * algorithm. That split exists because two earlier versions of this layout passed
 * a class-only assertion while rendering 3 + 1.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DimensionGrid } from "@/components/DimensionGrid";

function render(count: number): string {
  return renderToStaticMarkup(
    <DimensionGrid count={count}>
      {Array.from({ length: count }, (_, i) => (
        <article key={i}>card-{i}</article>
      ))}
    </DimensionGrid>,
  );
}

describe("DimensionGrid", () => {
  it("renders every card it is given", () => {
    const html = render(5);
    for (let i = 0; i < 5; i += 1) {
      expect(html).toContain(`card-${i}`);
    }
  });

  it("uses a wrapping, centre-justified flex container", () => {
    const html = render(5);
    expect(html).toContain("dimension-grid");
    expect(html).toContain("flex-wrap");
    // Centring is what turns an incomplete final row into a deliberate 3 + 2.
    expect(html).toContain("justify-center");
  });

  it("selects the two-up variant for four cards, giving a 2x2 block", () => {
    expect(render(4)).toContain("dimension-grid--two-up");
    expect(render(4)).not.toContain("dimension-grid--three-up");
  });

  it("selects the three-up variant for five cards, giving 3 + 2", () => {
    expect(render(5)).toContain("dimension-grid--three-up");
    expect(render(5)).not.toContain("dimension-grid--two-up");
  });

  it("keeps two and three cards in the two-up variant", () => {
    expect(render(2)).toContain("dimension-grid--two-up");
    expect(render(3)).toContain("dimension-grid--two-up");
  });

  it("keeps a single card in the two-up variant so it is not full-bleed", () => {
    expect(render(1)).toContain("dimension-grid--two-up");
  });
});
