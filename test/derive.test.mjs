// Strudel events → notes (doc 28 M2): one test per row of §2.2 and §2.4, through the real evaluator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createEvaluator } from '../src/strudel/evaluator.mjs';
import { hapsToChannels } from '../pipelines/_shared/skills/music/lib/score.mjs';

const dir = [process.env.MFX_STRUDEL, join(homedir(), 'Mortiflix', 'tools', 'strudel')].find((d) => d && existsSync(join(d, 'node_modules', '@strudel', 'core')));
const skip = dir ? false : 'Strudel is not installed';

test('§2.2: start, length (clip), key, velocity, chords', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const notes = async (code, o = {}) => { const r = await ev.run(code, { bars: 1, ...o }); assert.ok(r.ok, r.error); return r; };
  // start and length in ticks (3840 a bar in 4/4)
  assert.deepEqual((await notes('note("c3 e3")')).notes.map((n) => [n.t, n.len, n.key]), [[0, 1920, 48], [1920, 1920, 52]]);
  // .legato(2) is stored as clip: lengths double
  assert.deepEqual((await notes('note("c3 e3").legato(2)')).notes.map((n) => n.len), [3840, 3840]);
  // a 6/8 bar: 2880 ticks
  assert.deepEqual((await notes('note("c3 e3 g3")', { tpb: 2880 })).notes.map((n) => n.t), [0, 960, 1920]);
  // keys: names, numbers, scale steps, voiced chords, freq, decimal = fine pitch
  assert.deepEqual((await notes('note("60 c#4 db4")')).notes.map((n) => n.key), [60, 61, 61]);
  assert.deepEqual((await notes('n("0 2 4").scale("D3:dorian")')).notes.map((n) => n.key), [50, 53, 57]);
  assert.equal((await notes('chord("Dm7").voicing()')).notes.length >= 3, true);
  assert.deepEqual((await notes('freq("440")')).notes.map((n) => n.key), [69]);
  assert.deepEqual((await notes('note("38.12")')).notes.map((n) => [n.key, n.fine]), [[38, 12]]);
  // velocity: default 0.8, 3 decimals, clamped; gain never becomes velocity
  assert.deepEqual((await notes('note("c3 e3").velocity("<.6666 1.4>").gain(.3)')).notes.map((n) => n.vel), [0.667, 0.667]);
  assert.deepEqual((await notes('note("c3")')).notes.map((n) => n.vel), [0.8]);
  assert.deepEqual((await notes('note("c3").velocity(1.4)')).notes.map((n) => n.vel), [1]);
  // a chord is several notes at once
  assert.deepEqual((await notes('note("[c3,e3,g3]")')).notes.map((n) => [n.t, n.key]), [[0, 48], [0, 52], [0, 55]]);
  // off the grid: a 7-tuplet is rounded, with a warning
  const seven = await notes('note("c3*7")');
  assert.equal(seven.notes[1].t, Math.round(3840 / 7));
  assert.match(seven.problems[0], /off the 960 grid at bar 1/);
});

test('§2.2 drums: drum, then note, then the sample name as General MIDI', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const r = await ev.run('stack(s("bd sd"), note("42"), s("hh").drum(46))', { bars: 1, drums: true });
  assert.deepEqual(r.notes.map((n) => n.key).sort((a, b) => a - b), [36, 38, 42, 46]);
});

test('§2.4: what can\'t become MIDI says so', { skip }, async (t) => {
  const ev = createEvaluator({ strudelDir: dir });
  t.after(() => ev.close());
  const signal = await ev.run('note(sine.range(40, 50))', { bars: 1 });
  assert.equal(signal.notes.length, 0);
  assert.match(signal.problems[0], /needs \.segment/);
  assert.deepEqual((await ev.run('note(sine.range(40, 50).segment(4))', { bars: 1 })).notes.length, 4);
  const sample = await ev.run('stack(s("bd"), note("c3"))', { bars: 1 });
  assert.deepEqual(sample.notes.map((n) => n.key), [48]);
  assert.match(sample.problems[0], /a bd at bar 1, beat 1 has no pitch/);
  assert.match((await ev.run('note("c3").nudge(.01)', { bars: 1 })).hints.join(' '), /nudge moves the sound/);
  assert.match((await ev.run('note("c3").s("sawtooth").lpf(800)', { bars: 1 })).hints.join(' '), /sound settings/);
  // .late moves the notes and is read
  assert.deepEqual((await ev.run('note("c3").late(.25)', { bars: 2 })).notes.map((n) => n.t), [960, 4800]);
});

test('the score\'s MIDI reads .legato (hapsToChannels reads clip)', () => {
  const haps = [{ begin: 0, end: 0.25, value: { note: 'c3', midichan: 1, clip: 2 } }, { begin: 0.25, end: 0.5, value: { note: 'e3', midichan: 1, legato: 0.5 } }];
  const ch = hapsToChannels({ haps, cps: 0.5, beatsPerCycle: 4 });
  assert.deepEqual(ch.tracks[0].notes.map((n) => n.dur), [2, 0.5]);
});
