import { describe, expect, it, vi } from 'vitest';
import { ReviewSession } from '../src/lib/review/session.svelte';
import type { ReviewItem, ReviewService } from '../src/lib/review/types';
import { Problems } from '../src/lib/stores/problems.svelte';

const item = (state: ReviewItem['state'], pending = 0): ReviewItem => ({
  id: 'sf01',
  noun: 'frame',
  label: 'Opening',
  path: '/p.png',
  version: 1,
  versions: [],
  state,
  held: null,
  inspection: null,
  problems: [],
  lookAt: '',
  notes: [],
  pending,
  tablet: null,
  okWords: { notes: '', none: '' },
});

function make(call: ReviewService['call']) {
  const problems = new Problems();
  const reload = vi.fn(async () => {});
  const service: ReviewService = { call, on: () => () => {} };
  const session = new ReviewSession({
    service,
    problems,
    calls: 'frames',
    param: 'frame',
    problemId: 'look-act',
    reload,
    afterOk: (_item, result) => (result?.next === 'round' ? 'Writing the next round…' : ''),
  });
  return { session, problems, reload };
}

describe('ReviewSession', () => {
  it('OK sends the piece, clears the view and reloads', async () => {
    const call = vi.fn(async () => ({ next: 'round' }));
    const { session, reload } = make(call as unknown as ReviewService['call']);
    session.select('sf01');
    await session.ok(item('review'));
    expect(call).toHaveBeenCalledWith('frames.ok', { frame: 'sf01' });
    expect(session.view).toBeNull();
    expect(session.message).toBe('Writing the next round…');
    expect(reload).toHaveBeenCalled();
  });

  it('OK on a held piece is OK anyway; OK on a piece being made does nothing', async () => {
    const call = vi.fn(async () => ({}));
    const { session } = make(call as unknown as ReviewService['call']);
    await session.ok(item('making'));
    expect(call).not.toHaveBeenCalled();
    await session.ok(item('held'));
    expect(call).toHaveBeenCalledWith('frames.ok', { frame: 'sf01' });
  });

  it('Fix on a held piece needs no note: the check result is the change', async () => {
    const call = vi.fn(async () => ({}));
    const { session } = make(call as unknown as ReviewService['call']);
    await session.fix(item('held', 0));
    expect(call).toHaveBeenCalledWith('frames.fix', { frame: 'sf01' });
  });

  it('Fix needs a note on a piece in review, and sends a typed one with the call', async () => {
    const call = vi.fn(async () => ({}));
    const { session } = make(call as unknown as ReviewService['call']);
    await session.fix(item('review', 0));
    expect(call).not.toHaveBeenCalled();
    session.typed['sf01'] = '  bigger headline ';
    await session.fix(item('review', 0));
    expect(call).toHaveBeenCalledWith('frames.fix', { frame: 'sf01', text: 'bigger headline' });
    expect(session.typed['sf01']).toBe('');
  });

  it('says plainly when a call fails, and still reloads', async () => {
    const call = vi.fn(async () => {
      throw new Error('service is down');
    });
    const { session, problems, reload } = make(call as unknown as ReviewService['call']);
    await session.ok(item('review'));
    expect(problems.current?.text).toBe('OK was not saved: service is down. Nothing was changed.');
    expect(session.busy).toBe('');
    expect(reload).toHaveBeenCalled();
  });
});

describe('the note box keys', () => {
  it('Enter keeps the note; Shift+Enter is a new line; Enter while composing is the input method\'s', async () => {
    const { keepsNote } = await import('../src/lib/review/keys');
    expect(keepsNote({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
    expect(keepsNote({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    expect(keepsNote({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(keepsNote({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
  });
});
