import { describe, expect, it } from 'vitest';
import {
  canStopEarly,
  failedWords,
  frameItems,
  frameRows,
  frameTotal,
  frameWaitWords,
  lookHead,
  makingWords,
  noFramesWords,
  waitPlaceholder,
} from '../src/screens/look/frames';
import type { FrameEntry, FrameState, FramesState } from '../src/lib/review/types';

const frame = (id: string, state: FrameEntry['state'], round = 1): FrameEntry => ({
  id,
  label: `Frame ${id}`,
  round,
  state,
  version: 1,
  path: state === 'todo' ? '' : `/p/${id}.png`,
  hold_s: 8,
  why: 'The first moment.',
});

const state = (frames: FrameEntry[], extra: Partial<FramesState> = {}): FramesState => ({
  ok: frames.filter((f) => f.state === 'ok').length,
  total: frames.length,
  round: 1,
  rounds: 2,
  waiting_for: 'you',
  ok_words: { notes: 'OK · Remake this frame', none: 'OK · Next frame' },
  frames,
  ...extra,
});

describe('look frames', () => {
  const s = state([frame('a', 'ok'), frame('b', 'review'), frame('c', 'todo', 2)]);

  it('maps the service states to the shared ones', () => {
    expect(frameItems(s).map((i) => i.state)).toEqual(['ok', 'review', 'waiting']);
  });

  it('writes the head with hold time and round', () => {
    const items = frameItems(s);
    const head = lookHead(s, items[1] ?? null);
    expect(head.kicker).toBe('Look · Frame 2 of 3 · holds 8 s · Round 1 of 2');
    expect(head.help).toBe('Why this moment: The first moment.');
  });

  it('says all frames are OK when finished', () => {
    const done = state([frame('a', 'ok')], { waiting_for: 'done' });
    expect(lookHead(done, frameItems(done)[0] ?? null).title).toBe('All 1 frames OK');
  });

  it('marks a frame to check that is not the active one as next', () => {
    const two = state([frame('a', 'review'), frame('b', 'review')]);
    const rows = frameRows(two, frameItems(two), 'a');
    expect(rows[1]?.tag.text).toBe('Next to check');
    expect(rows[0]?.tag.text).toBe('To check');
  });

  it('offers Stop here only once every frame of round 1 is OK, while some wait', () => {
    const r1 = state([frame('a', 'ok'), frame('b', 'ok'), frame('c', 'todo', 2)]);
    expect(canStopEarly(r1)).toBe(true);
    expect(canStopEarly({ ...r1, enough: true })).toBe(false);
    expect(canStopEarly(s)).toBe(false); // 1 of round 1 OK, one still in review
    expect(canStopEarly(state([frame('a', 'review'), frame('b', 'todo')]))).toBe(false);
  });

  it('says what is happening while the studio writes', () => {
    expect(makingWords({ ...s, waiting_for: 'studio' }, true, '').title).toBe('◌ Writing this frame…');
    expect(makingWords({ ...s, waiting_for: 'studio' }, false, '').title).toBe('Not made yet');
    expect(makingWords({ ...s, waiting_for: 'studio' }, true, '', 'Working for 0:05.').body).toContain(
      'Working for 0:05.',
    );
    expect(makingWords(s, true, 'Writing the next round…').title).toBe('Writing the next round…');
    expect(noFramesWords({ ...s, frames: [], waiting_for: 'studio' }, '').title).toBe(
      '◌ Mortiflix is writing the first round of frames…',
    );
    expect(noFramesWords({ ...s, frames: [], waiting_for: 'you' }, '').title).toBe('No frames yet');
    expect(frameTotal({ ...s, total: 0, planned: 0 })).toBe(3);
  });
});

describe('why a frame that is not made waits (Dir2: SF01 said "after the frames before it")', () => {
  const okWords = { notes: 'OK · Remake this frame', none: 'OK · Next frame' };
  const entry = (id: string, round: number, state: FrameState): FrameEntry => ({
    id,
    label: id,
    round,
    state,
    version: 0,
  });
  const state: FramesState = {
    ok: 0,
    round: 1,
    rounds: 2,
    waiting_for: 'studio',
    ok_words: okWords,
    frames: [entry('sf01', 1, 'todo'), entry('sf02', 1, 'todo'), entry('sf03', 2, 'todo')],
  };
  const none = { here: false, failed: '', waiting: null };

  it('the first frame never waits for frames before it', () => {
    expect(frameWaitWords(state, 'sf01', { ...none, here: true })).toBe('Being made.');
    expect(frameWaitWords(state, 'sf01', { ...none, failed: 'The AI got stuck on this step.' })).toBe(
      'Failed: The AI got stuck on this step.',
    );
    expect(
      frameWaitWords(state, 'sf01', {
        ...none,
        waiting: {
          title: 'Waiting for Voice & music',
          body: "Music isn't made yet, so the frames can't start yet.",
        },
      }),
    ).toBe("Waiting: Music isn't made yet, so the frames can't start yet.");
    expect(frameWaitWords(state, 'sf01', none)).toBe('Not made yet.');
  });

  it('only a later round waits for the round before', () => {
    expect(frameWaitWords(state, 'sf03', { ...none, here: true })).toBe(
      "Made after round 1's frames are OK, so it gets what you tell us about them.",
    );
    const roundOneOk = {
      ...state,
      frames: [entry('sf01', 1, 'ok'), entry('sf02', 1, 'ok'), entry('sf03', 2, 'todo')],
    };
    expect(frameWaitWords(roundOneOk, 'sf03', { ...none, here: true })).toBe('Being made.');
  });

  it('the picture says the same', () => {
    expect(waitPlaceholder('Failed: The AI got stuck.').title).toBe('This frame could not be made');
    expect(waitPlaceholder('Being made.').title).toBe('◌ Being made…');
    expect(waitPlaceholder('Waiting: Voice needs your OK.')).toEqual({
      title: 'Waiting',
      body: 'Voice needs your OK.',
    });
  });
});

describe('a project that stopped on a problem (Dir1/Dir2: QUICK_GAVE_UP)', () => {
  const need = {
    text: "The step couldn't be finished by the studio: the style frames kept failing to render Likely cause: The studio tried several times.",
    cause: 'gave-up',
  };
  it("says the service's own sentence, without the likely cause", () => {
    expect(failedWords(need, 'The AI got stuck on this step.')).toBe(
      "The step couldn't be finished by the studio: the style frames kept failing to render",
    );
    expect(failedWords(null, 'The AI got stuck on this step.')).toBe('The AI got stuck on this step.');
  });
  it('the frames list says Failed, not Waits', () => {
    const items = frameItems({
      ok: 0,
      waiting_for: 'studio',
      ok_words: { notes: 'x', none: 'y' },
      frames: [frame('sf01', 'todo')],
    }).map((item) => ({ ...item, waitWords: 'Failed: it kept failing' }));
    const rows = frameRows(
      { ok: 0, waiting_for: 'studio', ok_words: { notes: 'x', none: 'y' }, frames: [frame('sf01', 'todo')] },
      items,
      undefined,
    );
    expect(rows[0]?.tag.text).toBe('Failed');
  });
});

describe('a Fix kept, not sent yet', () => {
  it('says so in the list and in the picture\'s words; once sent it is being made again', () => {
    const kept = { ...frame('a', 'fix'), fix_sent: false };
    const s = state([kept, frame('b', 'review')], { fixes_waiting: 1 });
    const items = frameItems(s);
    expect(items[0]?.state).toBe('making');
    expect(items[0]?.waitWords).toMatch(/^Fix kept/);
    expect(frameRows(s, items, 'b')[0]?.tag.text).toBe('Fix kept');
    const sent = state([{ ...kept, fix_sent: true }, frame('b', 'review')]);
    const sentItems = frameItems(sent);
    expect(sentItems[0]?.waitWords).toBeUndefined();
    expect(frameRows(sent, sentItems, 'b')[0]?.tag.text).not.toBe('Fix kept');
  });
});
