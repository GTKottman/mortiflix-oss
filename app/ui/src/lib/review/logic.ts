import type { Mark } from '../components/StatusMark.svelte';
import type { ItemState, ReviewItem, Tablet, VideoNotesStatus } from './types';

import { plural } from '../words';

export const seconds = (total: number): string =>
  total >= 60 ? `${Math.floor(total / 60)} min ${Math.round(total % 60)} s` : `${Math.round(total)} s`;

/** The look of one state tag: its colour class, glyph and words. Every state has all three. */
export type TagLook = Extract<Mark, 'ok' | 'busy' | 'fix' | 'wait' | 'bad'>;
export interface Tag {
  look: TagLook;
  glyph: string;
  text: string;
}

export const ITEM_TAGS: Record<ItemState, Tag> = {
  waiting: { look: 'wait', glyph: '○', text: 'Waits' },
  making: { look: 'busy', glyph: '◌', text: 'Being made' },
  review: { look: 'fix', glyph: '○', text: 'To check' },
  held: { look: 'fix', glyph: '!', text: 'Held' },
  ok: { look: 'ok', glyph: '✓', text: 'OK' },
};

/** Pack asset ids ("color:accent") as words ("colour accent"). */
export function assetWords(ids: readonly string[]): string[] {
  return ids.map((id) =>
    id
      .replace(/^color:/, 'colour ')
      .replace(/^tex:/, 'texture ')
      .replace(/^img:/, 'picture ')
      .replace(/^layout:/, 'layout ')
      .replace(/^(font|icon|model|doc):/, '$1 ')
      .replace(/:/g, ' '),
  );
}

/** The tablet pill's words, or null when Video Notes is off. `link` = the pill leads to Settings. */
export function tabletTag(
  tablet: Tablet | null,
  notes: VideoNotesStatus | null,
): (Tag & { link?: true }) | null {
  if (!notes?.enabled) return null;
  if (tablet) {
    if (tablet.status === 'reviewing') {
      const text = tablet.notes
        ? `You're reviewing · ${plural(tablet.notes, 'note')} so far`
        : "You're reviewing it";
      return { look: 'busy', glyph: '◌', text };
    }
    if (tablet.status === 'done') {
      return tablet.notes
        ? { look: 'fix', glyph: '!', text: `OK'd with ${plural(tablet.notes, 'note')} · remaking` }
        : { look: 'ok', glyph: '✓', text: "OK'd · making the next" };
    }
    return { look: 'wait', glyph: '○', text: 'Sent · not opened yet' };
  }
  if (notes.problems?.length && !(notes.addresses ?? []).some((address) => address.reachable)) {
    return { look: 'bad', glyph: '✕', text: "Can't reach it" };
  }
  if (!notes.tablet_seen) return { look: 'wait', glyph: '○', text: 'Not linked', link: true };
  return { look: 'wait', glyph: '○', text: 'Sent to the tablet' };
}

/** The piece to check now: a held one first, then one to check, then one being made. */
export function activeItem(items: readonly ReviewItem[]): ReviewItem | undefined {
  return (
    items.find((item) => item.state === 'held') ??
    items.find((item) => item.state === 'review') ??
    items.find((item) => item.state === 'making')
  );
}

/** What the screen shows: the one asked for, else the active one, else the last OK, else the first. */
export function currentItem(items: readonly ReviewItem[], viewId: string | null): ReviewItem | null {
  if (!items.length) return null;
  return (
    items.find((item) => item.id === viewId) ??
    activeItem(items) ??
    [...items].reverse().find((item) => item.state === 'ok') ??
    items[0] ??
    null
  );
}
