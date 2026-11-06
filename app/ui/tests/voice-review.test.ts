import { describe, expect, it } from 'vitest';
import {
  cueName,
  isBad,
  issuesOf,
  lineName,
  pauseAfter,
  reasonOf,
  scenesOf,
  stepIssue,
} from '../src/screens/voice/review';
import type { LineCheck, MusicCue, VoiceLine } from '../src/screens/voice/types';

const line = (node: string, beat: string, no: number, start: number, state = 'approved'): VoiceLine => ({
  node,
  words: node,
  path: '/x.wav',
  start_sec: start,
  dur_sec: 2,
  beat,
  beat_no: no,
  state,
});

const check = (id: string, ok: boolean | null, missing: string[] = [], extra: string[] = []): LineCheck => ({
  id,
  role: 'narrator',
  text: id,
  tags: [],
  gap_after: null,
  stability: null,
  checked: true,
  ok,
  missing,
  extra,
  words: [],
});

const lines = [line('a1', 'b1', 1, 0), line('a2', 'b1', 1, 3, 'waiting'), line('b1', 'b2', 2, 6)];

describe('voice review rules', () => {
  it('names a line by scene and place in the scene', () => {
    expect(lineName(lines, 'a2')).toBe('Scene 1 · line 2');
    expect(lineName(lines, 'zzz')).toBe('Line');
    expect(cueName('mc03')).toBe('Music 3');
  });

  it('says a line is bad from the check, or from the view when there is no check', () => {
    expect(isBad(line('x', 'b', 1, 0), check('x', false))).toBe(true);
    expect(isBad(line('x', 'b', 1, 0), check('x', true))).toBe(false);
    expect(isBad({ ...line('x', 'b', 1, 0), checked: true, words_ok: false }, undefined)).toBe(true);
  });

  it('explains why a line needs a look', () => {
    const l = line('x', 'b', 1, 0);
    expect(reasonOf(l, check('x', false, ['a'], ['b', 'c']), false)).toBe('3 words differ from the script');
    expect(reasonOf(l, check('x', false, ['a']), false)).toBe('1 word differs from the script');
    expect(reasonOf({ ...l, state: 'waiting' }, undefined, true)).toBe('Being made');
    expect(reasonOf({ ...l, state: 'waiting' }, undefined, false)).toBe('Not approved yet');
  });

  it('lists scenes with the second each starts', () => {
    expect(scenesOf(lines).map((s) => [s.no, s.start])).toEqual([
      [1, 0],
      [2, 6],
    ]);
  });

  it('takes the pause from the check, else from the gap to the next line', () => {
    expect(pauseAfter(lines, 0, { ...check('a1', true), gap_after: 0.35 })).toBe(0.35);
    expect(pauseAfter(lines, 0, undefined)).toBe(1);
    expect(pauseAfter(lines, 2, undefined)).toBeNull();
  });

  it('collects issues in time order and steps through them round the ends', () => {
    const cues: MusicCue[] = [{ id: 'mc01', from_sec: 1, to_sec: 5, state: 'made' }];
    const issues = issuesOf(
      lines,
      (id) => (id === 'b1' ? check('b1', false) : undefined),
      () => false,
      cues,
    );
    expect(issues.map((i) => i.id)).toEqual(['mc01', 'a2', 'b1']);
    expect(stepIssue(issues, null, 1)?.id).toBe('mc01');
    expect(stepIssue(issues, null, -1)?.id).toBe('b1');
    expect(stepIssue(issues, 'b1', 1)?.id).toBe('mc01');
    expect(stepIssue([], null, 1)).toBeNull();
  });
});
