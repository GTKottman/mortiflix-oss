import { describe, expect, it } from 'vitest';
import { elapsedText } from '../src/lib/time';
import {
  chipMark,
  creditsFor,
  cuesToSignOff,
  cueStatus,
  everyShotDone,
  gainFromDb,
  markSpan,
  motionDone,
  newSounds,
  okState,
  shotAfter,
  shotToOpen,
  shotToPrice,
  shotFraction,
  sourceChip,
  stopNote,
} from '../src/screens/sound/sound';
import type { Cue, SoundPlan } from '../src/screens/sound/types';

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'fx1',
  shot: 'b01',
  at_sec: 2,
  dur_sec: 0.8,
  what: 'Title',
  prompt: 'Pen',
  source: 'generate',
  status: 'planned',
  ...over,
});
const plan = (cues: Cue[]): SoundPlan => ({
  shots: [{ id: 'b01', number: 1, from: 0, to: 10, talk: [] }],
  cues,
  summary: { cues: cues.length, library: 0, new: 0, to_make: 0, credits: 0 },
});

describe('credits', () => {
  it('uses the service\'s measured cost per row, else ~12 per second rounded up', () => {
    expect(creditsFor(cue({ dur_sec: 0.6, credits: 7 }))).toBe(7);
    expect(creditsFor(cue({ dur_sec: 0.8 }))).toBe(10);
    expect(creditsFor(cue({ dur_sec: 2.1 }))).toBe(26);
  });
  it('is free from the library or once made', () => {
    expect(creditsFor(cue({ source: 'library' }))).toBe(0);
    expect(creditsFor(cue({ file: '/a.mp3' }))).toBe(0);
  });
});

describe('words', () => {
  it('shows each status in words, "making" only for sounds still to make', () => {
    expect(cueStatus(cue(), false)).toEqual({ mark: 'wait', text: 'Not made yet' });
    expect(cueStatus(cue(), true)).toEqual({ mark: 'busy', text: 'Making' });
    expect(cueStatus(cue({ failed: 'came back nearly silent (peak -36.0 dBFS)' }), false)).toEqual({ mark: 'fix', text: 'Came back nearly silent · make again' });
    expect(cueStatus(cue({ status: 'cut', cut_by: 'finish', note: 'inside the quoted line b06-1' }), false)).toEqual({ mark: 'cut', text: 'Left out by Finish: inside the quoted line b06-1' });
    expect(cueStatus(cue({ source: 'library', status: 'ready' }), true).text).toBe('Made · to check');
    expect(cueStatus(cue({ status: 'cut' }), true).text).toBe('Cut');
  });
  it('names where a sound comes from', () => {
    expect(sourceChip(cue({ source: 'library' }))).toBe('Library');
    expect(sourceChip(cue({ credits: 7 }))).toBe('New · 7 credits');
    expect(sourceChip(cue({ cached: true }))).toBe('Made before · free');
    expect(sourceChip(cue({ from_library: true }))).toBe('Made before · free');
    expect(sourceChip(cue({ file: '/a' }))).toBe('New · made');
  });
  it('counts new sounds', () => {
    expect(newSounds(1)).toBe('1 new sound');
    expect(newSounds(13)).toBe('13 new sounds');
  });
});

describe('progress', () => {
  it('a shot chip counts what is still new, a check when all are OK', () => {
    const p = plan([cue(), cue({ id: 'fx2', status: 'cut' })]);
    const [shot] = p.shots;
    if (!shot) throw new Error('no shot');
    expect(chipMark(p, shot, false)).toEqual({ glyph: '', news: ' · 1 new' });
    expect(chipMark(p, shot, true).glyph).toBe('◌');
    expect(chipMark(plan([cue({ source: 'library', status: 'ok' })]), shot, false)).toEqual({
      glyph: '✓',
      news: '',
    });
  });
  it('the film is done only when every shot is OK and nothing is left to make', () => {
    expect(everyShotDone(plan([cue({ file: '/a', status: 'ok' })]))).toBe(true);
    expect(everyShotDone(plan([cue({ status: 'ok' })]))).toBe(false);
    expect(everyShotDone(plan([cue({ file: '/a', status: 'ready' })]))).toBe(false);
  });
  it('the motion gate lets unknown progress through', () => {
    expect(motionDone(null)).toBe(true);
    expect(motionDone({ total: 6, ok: 6, nodes: [] })).toBe(true);
    expect(motionDone({ total: 6, ok: 3, nodes: [] })).toBe(false);
    expect(motionDone({ total: 0, ok: 0, nodes: [] })).toBe(false);
  });
});

describe('timeline', () => {
  const shot = { from: 10, to: 20 };
  it('places a time inside its shot, 0 to 1', () => {
    expect(shotFraction(shot, 15)).toBe(0.5);
    expect(shotFraction(shot, 5)).toBe(0);
    expect(shotFraction(shot, 30)).toBe(1);
  });
  it('a bar ends where its motion ends, or before the next sound', () => {
    const cues = [cue({ at_sec: 12, dur_sec: 1 }), cue({ id: 'b', at_sec: 12.5, dur_sec: 1 })];
    expect(markSpan(shot, cues, 0).left).toBe(20);
    expect(markSpan(shot, cues, 0).width).toBeCloseTo(4.2, 5);
    expect(markSpan(shot, cues, 1).width).toBe(10);
  });
  it('turns decibels into a volume, never above full', () => {
    expect(gainFromDb(0)).toBe(1);
    expect(gainFromDb(6)).toBe(1);
    expect(gainFromDb(-20)).toBeCloseTo(0.1);
  });
});

describe('the OK shot button', () => {
  it('has nothing to OK when the shot has no sounds', () => {
    expect(okState([])).toEqual({ kind: 'none' });
  });
  it('is signed once every sound is OK', () => {
    expect(okState([cue({ status: 'ok', file: '/a.mp3' })])).toEqual({ kind: 'signed' });
  });
  it('is ready when every new sound is made and one still needs an OK', () => {
    expect(okState([cue({ status: 'ready', file: '/a.mp3' })])).toEqual({ kind: 'ready' });
  });
  it('says how many sounds are not made yet', () => {
    expect(okState([cue(), cue({ id: 'fx2' })])).toEqual({
      kind: 'blocked',
      reason: '2 sounds are not made yet',
    });
    expect(okState([cue()])).toEqual({ kind: 'blocked', reason: '1 sound is not made yet' });
  });
  it('is blocked with a reason when nothing is left to OK', () => {
    expect(okState([cue({ source: 'library', status: 'planned' })])).toEqual({
      kind: 'blocked',
      reason: 'Nothing to OK in this shot',
    });
  });
});

describe('moving between shots', () => {
  const shots = (ids: string[]): SoundPlan => ({
    ...plan([]),
    shots: ids.map((id, k) => ({ id, number: k + 1, from: k * 10, to: k * 10 + 10, talk: [] })),
  });
  it('signs off only made sounds that are not OK or cut', () => {
    const made = cue({ id: 'a', file: '/a.mp3', status: 'ready' });
    const signed = cue({ id: 'b', file: '/b.mp3', status: 'ok' });
    const cut = cue({ id: 'c', file: '/c.mp3', status: 'cut' });
    const unmade = cue({ id: 'd' });
    expect(cuesToSignOff([made, signed, cut, unmade])).toEqual([made]);
  });
  it('finds the shot after one, and none after the last', () => {
    const two = shots(['s1', 's2']);
    expect(shotAfter(two, 's1')?.id).toBe('s2');
    expect(shotAfter(two, 's2')).toBeUndefined();
  });
  it('keeps the open shot, else the wanted one, else the first', () => {
    const two = shots(['s1', 's2']);
    expect(shotToOpen(two, 's2', 's1')).toBe('s2');
    expect(shotToOpen(two, '', 's2')).toBe('s2');
    expect(shotToOpen(two, '', 'gone')).toBe('s1');
    expect(shotToOpen(two, '', null)).toBe('s1');
    expect(shotToOpen(shots([]), '', null)).toBe('');
  });
  it('prices the open shot when it has sounds to make, else the first shot that has', () => {
    const both: SoundPlan = {
      ...shots(['s1', 's2']),
      cues: [cue({ id: 'a', shot: 's1', file: '/a.mp3' }), cue({ id: 'b', shot: 's2' })],
    };
    expect(shotToPrice(both, 's1')?.id).toBe('s2');
    expect(shotToPrice(both, 's2')?.id).toBe('s2');
    expect(shotToPrice({ ...both, cues: [] }, 's1')).toBeUndefined();
  });
});

describe('making stopped early', () => {
  it('says nothing when it ran to the end', () => {
    expect(stopNote({ calls: 1, credits: 0, made: ['a'] }, 1)).toBeNull();
  });
  it('names a billing stop and what was spent', () => {
    const note = stopNote({ calls: 3, credits: 0, made: ['a', 'b'], stopped: { billing: true } }, 5);
    expect(note?.billing).toBe(true);
    expect(note?.text).toBe(
      'ElevenLabs said no (billing or limit). 2 of 5 sounds were made and nothing more was spent.',
    );
  });
  it('names the error of any other stop', () => {
    const note = stopNote({ calls: 1, credits: 0, stopped: { error: 'timeout' } }, 3);
    expect(note).toEqual({ billing: false, text: 'Stopped at one sound: timeout. 0 of 3 were made.' });
  });
});

describe('elapsed time', () => {
  it('counts seconds, then minutes with two-digit seconds', () => {
    expect(elapsedText(0)).toBe('0 s');
    expect(elapsedText(42_900)).toBe('42 s');
    expect(elapsedText(60_000)).toBe('1 min 00 s');
    expect(elapsedText(185_000)).toBe('3 min 05 s');
  });
  it('never goes below zero (a clock that moved back)', () => {
    expect(elapsedText(-5000)).toBe('0 s');
  });
});
