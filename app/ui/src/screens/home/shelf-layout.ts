// How a shelf of project cards fits its width, and which cards it shows. Up to three cards sit side by side
// (owner's Projects drawing, 2026-11-05), the ‹ › buttons either side.

/** Widest a card gets, in px. */
const CARD = 320;
/** Gap between cards in px; the same as --s-16. */
export const GAP = 16;
/** A ‹ › button and its gap to the cards: --h + --s-16. */
const SIDE = 36 + GAP;
const MOST_SHOWN = 3;

export interface Fit {
  /** Cards shown at once. */
  shown: number;
  /** One card's width in px. */
  card: number;
}

export function shelfFit(width: number): Fit {
  const room = Math.max(width - 2 * SIDE, 1);
  const shown = Math.max(1, Math.min(MOST_SHOWN, Math.floor((room + GAP) / (CARD + GAP))));
  return { shown, card: Math.min(CARD, room) };
}

/** The furthest the shelf can slide: the last card sits at its end. */
export const lastStart = (count: number, shown: number): number => Math.max(count - shown, 0);

export const clampStart = (start: number, count: number, shown: number): number =>
  Math.max(0, Math.min(start, lastStart(count, shown)));

/** Offset in card steps from the middle for the nth newest card: the 2nd goes right, the 3rd left, the 4th right. */
export const slotOf = (index: number): number => {
  if (index === 0) return 0;
  return index % 2 ? (index + 1) / 2 : -index / 2;
};

/** "Making" keeps its newest in the middle: the list in the order it reads left to right. */
export function middleOut<T>(newestFirst: readonly T[]): T[] {
  return newestFirst
    .map((item, index) => ({ item, slot: slotOf(index) }))
    .sort((a, b) => a.slot - b.slot)
    .map(({ item }) => item);
}

/** Where a middle-out shelf starts so its newest card is as central as it can be. */
export function middleStart(count: number, shown: number): number {
  const newest = Math.floor((count - 1) / 2);
  return clampStart(newest - Math.floor(shown / 2), count, shown);
}
