"use client";

/**
 * Lays out the dimension cards so the row is always full.
 *
 * Only *applicable* dimensions are ever passed in — the caller filters out
 * dimensions that do not apply to the trip (a same-currency trip has no exchange
 * rate to score). Showing a "not applicable" placeholder card was the previous
 * behaviour and it read as a failure, so it is gone.
 *
 * Given that, the card count is 2–5 and the layout depends on it:
 *   - up to 4 cards -> 2 across from tablet up, so an even count fills the row
 *     completely (4 cards become a solid 2x2).
 *   - 5 cards       -> 3 across from desktop, laid out 3 + 2. Not 5 equal columns,
 *     which would squeeze each card to roughly 180px and truncate every driver
 *     sentence into unreadability.
 *
 * The column count is selected by a variant class rather than by a single set of
 * breakpoint rules, because a bare `min-width: 1024px` rule would apply to the
 * four-card case too and turn a 2x2 block into 3 + 1. See `globals.css`.
 *
 * Wrapping flex rather than a fixed grid, because the count varies by trip and a
 * fixed column count would leave a gap in one of the cases. An incomplete final
 * row is centred by `justify-center`, so 3 + 2 reads as a deliberate grouping.
 *
 * Equal height within a row comes from `.dimension-grid > *`, so the expandable
 * "data details" panel on one card cannot make it taller than its neighbours.
 */
export function DimensionGrid({
  count,
  children,
}: {
  /** How many cards are being rendered. Drives the column count. */
  count: number;
  children: React.ReactNode;
}) {
  // Five usable cards is the only case that goes three-up; four or fewer stay
  // two-up so an even count always fills its row.
  const variant = count >= 5 ? "dimension-grid--three-up" : "dimension-grid--two-up";

  return (
    <div
      className={`dimension-grid ${variant} flex flex-wrap justify-center gap-4 sm:gap-5`}
    >
      {children}
    </div>
  );
}
