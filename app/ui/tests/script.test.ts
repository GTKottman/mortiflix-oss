import { describe, expect, it } from 'vitest';
import { shortcutFor, type KeyPress } from '../src/screens/script/keys';
import { fixtureSource } from '../src/screens/script/fixtures';
import { stateOf } from '../src/screens/script/status';
import {
  creditsFor,
  firstToReview,
  okCostText,
  nextToReview,
  secondsLabel,
  summarize,
  timingsFor,
  voiceByLine,
  wordsOf,
} from '../src/screens/script/timing';
import type { Beat, BeatState, VoiceLine } from '../src/screens/script/types';

const beat = (id: string, words: string[], state: BeatState = 'ready', target?: number): Beat => ({
  id,
  no: 1,
  name: id,
  state,
  target_sec: target,
  lines: words.map((w, k) => ({ id: `${id}-${k + 1}`, words: w })),
});

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  tag: 'ARTICLE',
  editable: false,
  ...extra,
});

describe('timing', () => {
  it('counts words', () => {
    expect(wordsOf('  So, this   week? ')).toBe(3);
  });

  it('estimates from the words at 150 a minute when there is no voice', () => {
    const words = Array.from({ length: 150 }, () => 'a').join(' ');
    const [a] = Object.values(timingsFor([beat('b1', [words])], {}, {}));
    expect(a).toMatchObject({ dur: 60, est: true, words: 150 });
  });

  it('uses the recorded voice when the scene is voiced and unchanged', () => {
    const voice: Record<string, VoiceLine> = {
      'b1-1': { node: 'b1-1', start_sec: 1, dur_sec: 2, path: '/v.mp3' },
      'b1-2': { node: 'b1-2', start_sec: 4, dur_sec: 3, path: '/v.mp3' },
    };
    const beats = [beat('b1', ['One.', 'Two.'])];
    expect(timingsFor(beats, voice, {}).b1).toMatchObject({ start: 1, dur: 6, est: false });
    expect(timingsFor(beats, voice, { 'b1-2': 'Changed words here.' }).b1?.est).toBe(true);
  });

  it('keeps the recorded length for a line the owner edited once, until its words change after the take', () => {
    const voice = (changed: boolean): Record<string, VoiceLine> => ({
      'b1-1': { node: 'b1-1', start_sec: 0, dur_sec: 2, path: '/v.mp3', words_changed: changed },
    });
    const edited: Beat = { ...beat('b1', ['One.']), lines: [{ id: 'b1-1', words: 'One.', changed: true }] };
    expect(timingsFor([edited], voice(false), {}).b1?.est).toBe(false);
    expect(timingsFor([edited], voice(true), {}).b1?.est).toBe(true);
  });

  it('starts a voiced scene after an estimated one where that one ends, not at its old voice time', () => {
    const voice: Record<string, VoiceLine> = {
      'a-1': { node: 'a-1', start_sec: 0, dur_sec: 2, path: '/v.mp3' },
      'b-1': { node: 'b-1', start_sec: 30, dur_sec: 3, path: '/v.mp3' },
    };
    const beats = [beat('a', ['One.']), beat('b', ['Two.'])];
    const edited = timingsFor(beats, voice, { 'a-1': Array.from({ length: 150 }, () => 'w').join(' ') });
    expect(edited.b).toMatchObject({ start: 60, dur: 3, est: false });
    expect(timingsFor(beats, voice, {}).b).toMatchObject({ start: 30, dur: 3 });
  });

  it('reads the voice list, and anything else as no voice', () => {
    const line: VoiceLine = { node: 'x', dur_sec: 1 };
    expect(voiceByLine([line]).x).toBe(line);
    expect(voiceByLine({ lines: [line] })).toEqual({});
    expect(voiceByLine(null)).toEqual({});
  });

  it('labels 59.6 s as 1:00, not 60 s', () => {
    expect(secondsLabel(59.4)).toBe('59 s');
    expect(secondsLabel(59.6)).toBe('1:00');
  });

  it('says over, short or fits against the chosen length', () => {
    const beats = [beat('b1', ['a b c d e f g h i j'], 'approved', 10)];
    const spoken = (n: number) => ({
      b1: { start: 0, dur: n, est: false, words: 10 },
    });
    expect(summarize(beats, spoken(10.5), {}).fit).toEqual({ kind: 'fits' });
    expect(summarize(beats, spoken(14), {}).fit).toEqual({ kind: 'over', seconds: 4 });
    expect(summarize(beats, spoken(6), {}).fit).toEqual({ kind: 'short', seconds: 4 });
    expect(summarize(beats, spoken(10), {}).approved).toBe(1);
    expect(summarize(beats, spoken(10), { 'b1-1': 'edited' }).approved).toBe(0);
  });

  it('decides the fit on the exact gap, and never says 0 s', () => {
    const beats = [beat('b1', ['a'], 'ready', 10)];
    const spoken = (n: number) => ({ b1: { start: 0, dur: n, est: false, words: 1 } });
    expect(summarize(beats, spoken(11.04), {}).fit).toEqual({ kind: 'over', seconds: 1 });
    expect(summarize([beat('b1', ['a'], 'ready', 4)], spoken(4.45), {}).fit).toEqual({
      kind: 'over',
      seconds: 1,
    });
  });

  it('counts the spoken length to where the last scene ends, pauses included', () => {
    const beats = [beat('a', ['x']), beat('b', ['x'])];
    const timings = {
      a: { start: 0, dur: 2, est: false, words: 1 },
      b: { start: 3, dur: 2, est: false, words: 1 },
    };
    expect(summarize(beats, timings, {}).spoken).toBe(5);
    expect(summarize([], {}, {}).fit).toBeNull();
  });

  it('counts edited approved scenes as waiting, and cut or busy ones not', () => {
    const beats = [beat('a', ['x'], 'approved'), beat('b', ['x'], 'cut'), beat('c', ['x'], 'generating')];
    expect(summarize(beats, {}, {}).waiting).toBe(0);
    expect(summarize(beats, {}, { 'a-1': 'edit' }).waiting).toBe(1);
    expect(firstToReview(beats, { 'a-1': 'edit' })?.id).toBe('a');
  });

  it('finds the next scene to review, skipping edited ones and wrapping round', () => {
    const [a, b, c] = [beat('a', ['x']), beat('b', ['x'], 'approved'), beat('c', ['x'])];
    const beats = [a, b, c];
    expect(nextToReview(beats, a, {})?.id).toBe('c');
    expect(nextToReview(beats, c, {})?.id).toBe('a');
    expect(nextToReview(beats, a, { 'c-1': 'edit' })).toBeUndefined();
    expect(firstToReview(beats, { 'a-1': 'edit' })?.id).toBe('c');
    expect(firstToReview([b], {})).toBeUndefined();
  });
});

describe('status', () => {
  it('puts sending before edited before making before approved', () => {
    const b = beat('a', ['x'], 'approved');
    expect(stateOf(b, { 'a-1': 'y' }, undefined).text).toBe('Edited');
    expect(stateOf(b, {}, 'ok').text).toBe('Sending OK…');
    expect(stateOf(b, {}, 'clear').text).toBe('Reopening…');
    expect(stateOf(b, {}, 'undo').text).toBe('Undoing save…');
    expect(stateOf(beat('a', ['x'], 'generating'), {}, undefined).text).toBe('Making');
    expect(stateOf(b, {}, undefined).text).toBe('Approved');
    expect(stateOf(beat('a', ['x']), {}, undefined).text).toBe('Needs review');
  });
});

describe('fixtures', () => {
  it('reach writing with no scene and nothing started yet', async () => {
    expect(await fixtureSource('first-words').script()).toMatchObject({ writing: true, beats: [] });
    expect(await fixtureSource('empty').script()).toMatchObject({ writing: false, beats: [] });
  });

  it('mark the voice stale after an edit, so the scene time becomes an estimate', async () => {
    const source = fixtureSource('6');
    await source.edit([{ beat: 'b01', line: 'b01-1', words: 'New words.' }]);
    const said = (await source.voice()).find((v) => v.node === 'b01-1');
    expect(said?.words_changed).toBe(true);
    expect((await source.script()).beats[0]?.state).toBe('ready');
  });
});

describe('shortcuts', () => {
  it('maps Enter, F and the movement keys', () => {
    expect(shortcutFor(press('Enter'))).toBe('approve');
    expect(shortcutFor(press('F'))).toBe('fix');
    expect(shortcutFor(press('e'))).toBe('edit');
    expect(shortcutFor(press('ArrowDown'))).toBe('next');
    expect(shortcutFor(press('k'))).toBe('previous');
    expect(shortcutFor(press('x'))).toBeNull();
  });

  it('stays out of typing, modifiers and controls', () => {
    expect(shortcutFor(press('f', { tag: 'TEXTAREA' }))).toBeNull();
    expect(shortcutFor(press('f', { editable: true }))).toBeNull();
    expect(shortcutFor(press('f', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(press('Enter', { tag: 'BUTTON' }))).toBeNull();
    expect(shortcutFor(press('f', { tag: 'BUTTON' }))).toBe('fix');
  });
});

describe('what an OK spends', () => {
  const line = (id: string, words: string) => ({ id, words });
  const beats = [
    { id: 'a', no: 1, name: 'A', state: 'approved', lines: [line('a-1', 'Hello there.')] },
    { id: 'b', no: 2, name: 'B', state: 'ready', lines: [line('b-1', 'Four words in here.')] },
    { id: 'c', no: 3, name: 'C', state: 'ready', lines: [line('c-1', 'Six.')] },
  ] as Beat[];
  const [, b, c] = beats as [Beat, Beat, Beat];
  it('counts a character a credit, only for lines without an up-to-date take', () => {
    expect(creditsFor(beats, {})).toBe(12 + 19 + 4);
    expect(creditsFor(beats, { 'a-1': { node: 'a-1', path: '/a.wav' } })).toBe(23);
    expect(creditsFor(beats, { 'a-1': { node: 'a-1', path: '/a.wav', words_changed: true } })).toBe(35);
    const rewritten = beats.map((x) =>
      x.id === 'a' ? { ...x, lines: [{ id: 'a-1', words: 'Hello there.', words_changed: true }] } : x,
    );
    expect(creditsFor(rewritten, { 'a-1': { node: 'a-1', path: '/a.wav' } })).toBe(35);
  });
  it('says the scene cost, the whole voice on the last OK, and nothing when the voice is free', () => {
    expect(okCostText(beats, b, {}, true)).toBe("OK records this scene's voice: about 19 ElevenLabs credits");
    const lastOne = beats.map((x) => (x.id === 'b' ? { ...x, state: 'approved' as const } : x));
    expect(okCostText(lastOne, c, { 'a-1': { node: 'a-1', path: '/a.wav' } }, true)).toBe(
      'OK starts the voice recording: about 23 ElevenLabs credits',
    );
    expect(okCostText(beats, b, {}, false)).toBeNull();
  });
});

describe('pace', () => {
  it('estimates a scene from the narrator pace script.get gives', () => {
    const beat = {
      id: 'p',
      no: 1,
      name: 'P',
      state: 'ready',
      lines: [{ id: 'p-1', words: 'one two three four five six' }],
    } as Beat;
    expect(timingsFor([beat], {}, {}, 120).p?.dur).toBeCloseTo(3);
    expect(timingsFor([beat], {}, {}).p?.dur).toBeCloseTo(2.4);
  });
});
