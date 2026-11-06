import { describe, expect, it } from 'vitest';
import { plural } from '../src/lib/words';
import { activeItem, assetWords, currentItem, seconds, tabletTag } from '../src/lib/review/logic';
import type { ReviewItem, VideoNotesStatus } from '../src/lib/review/types';

const item = (id: string, state: ReviewItem['state']): ReviewItem => ({
  id,
  noun: 'frame',
  label: id,
  path: '',
  version: 1,
  versions: [],
  state,
  held: null,
  inspection: null,
  problems: [],
  lookAt: '',
  notes: [],
  pending: 0,
  tablet: null,
  okWords: { notes: '', none: '' },
});

describe('words', () => {
  it('pluralises and formats seconds', () => {
    expect(plural(1, 'note')).toBe('1 note');
    expect(plural(3, 'note')).toBe('3 notes');
    expect(seconds(32)).toBe('32 s');
    expect(seconds(95)).toBe('1 min 35 s');
  });

  it('turns pack asset ids into words', () => {
    expect(assetWords(['color:accent', 'tex:paper', 'font:Sora'])).toEqual([
      'colour accent',
      'texture paper',
      'font Sora',
    ]);
  });
});

describe('which piece is on view', () => {
  const items = [item('a', 'ok'), item('b', 'review'), item('c', 'held'), item('d', 'waiting')];

  it('picks held first, then to check', () => {
    expect(activeItem(items)?.id).toBe('c');
    expect(activeItem(items.slice(0, 2))?.id).toBe('b');
  });

  it('keeps the one asked for, else the active one, else the last OK, else the first', () => {
    expect(currentItem(items, 'a')?.id).toBe('a');
    expect(currentItem(items, 'zzz')?.id).toBe('c');
    expect(currentItem([item('a', 'ok'), item('b', 'ok')], null)?.id).toBe('b');
    expect(currentItem([item('a', 'waiting')], null)?.id).toBe('a');
    expect(currentItem([], null)).toBeNull();
  });
});

describe('tabletTag', () => {
  const on: VideoNotesStatus = {
    enabled: true,
    tablet_seen: '2026-11-01',
    addresses: [{ kind: 't', url: 'u', reachable: true }],
  };

  it('is absent when Video Notes is off', () => {
    expect(tabletTag(null, { enabled: false })).toBeNull();
    expect(tabletTag(null, null)).toBeNull();
  });

  it('reads the tablet state in words', () => {
    expect(tabletTag({ status: 'reviewing', notes: 2 }, on)?.text).toBe("You're reviewing · 2 notes so far");
    expect(tabletTag({ status: 'done', notes: 0 }, on)?.text).toBe("OK'd · making the next");
    expect(tabletTag({ status: 'done', notes: 1 }, on)?.text).toBe("OK'd with 1 note · remaking");
    expect(tabletTag({ status: 'sent', notes: 0 }, on)?.text).toBe('Sent · not opened yet');
  });

  it('says when it is not linked or cannot be reached', () => {
    expect(tabletTag(null, { enabled: true })?.link).toBe(true);
    expect(tabletTag(null, { enabled: true, problems: ['x'], addresses: [] })?.text).toBe("Can't reach it");
    expect(tabletTag(null, on)?.text).toBe('Sent to the tablet');
  });
});
