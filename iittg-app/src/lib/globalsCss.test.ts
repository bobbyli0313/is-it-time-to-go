/**
 * Asserts the dimension grid's stylesheet contract.
 *
 * These rules live in CSS rather than in a component because the basis needs
 * `calc()` against the container width and a selector list that Tailwind
 * utilities cannot express (a class built by string interpolation would never be
 * generated). The rules are therefore invisible to the component tests.
 *
 * Whether the resulting wrap actually produces the right rows is checked
 * numerically in `gridGeometry.test.ts`. This file guards the structure those
 * numbers depend on: the shared base rule, the variant-scoped basis rules, and the
 * breakpoints they sit behind.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);
const flat = css.replace(/\s+/g, " ");

describe("dimension grid CSS", () => {
  it("caps card width so the wrap point is driven by space, not content", () => {
    expect(flat).toContain(
      ".dimension-grid > * { flex: 0 1 100%; min-width: 0; }",
    );
  });

  it("gives both variants two across from 640px, subtracting the gap", () => {
    expect(flat).toContain(
      ".dimension-grid--two-up > *, .dimension-grid--three-up > * { flex-basis: calc((100% - 1.25rem) / 2); }",
    );
  });

  it("gives only the three-up variant three across from 1024px", () => {
    expect(flat).toContain(
      ".dimension-grid--three-up > * { flex-basis: calc((100% - 2.5rem) / 3); }",
    );
  });

  /**
   * The regression that shipped twice: a desktop rule scoped to the bare base
   * selector applied to every card count and turned the 2x2 layout into 3 + 1.
   * Every grid rule inside a breakpoint must therefore name a variant.
   */
  it("never applies a basis rule to the bare base selector inside a breakpoint", () => {
    const blocks = [...css.matchAll(/@media[^{]+\{([\s\S]*?)\n\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    for (const block of blocks) {
      for (const rule of block[1].matchAll(/([^{}]+)\{([^}]+)\}/g)) {
        const selector = rule[1].trim();
        if (!selector.includes(".dimension-grid")) continue;
        expect(selector).toMatch(/--two-up|--three-up/);
      }
    }
  });

  it("keeps the basis gap maths consistent with the container gap", () => {
    // The basis values subtract 1.25rem and 2.5rem, which are exactly two and four
    // lots of the container's sm:gap-5. If the container gap changed without the
    // basis following, a row would overflow and wrap one card early.
    expect(flat).toContain("1.25rem");
    expect(flat).toContain("2.5rem");
  });
});
