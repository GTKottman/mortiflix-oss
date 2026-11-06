// The song lane's timing rules (doc 19 §1–2): bars on the video's time axis, shots back to back, cut marks by the
// one-frame rule; and the API that feeds it (the song, or a draft from the score before the import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timeAxis, shotTimes, cutMarks } from '../web/songlane.js';
import { emptySong } from '../src/song.mjs';

test('bars and ticks land on the video\'s seconds from offsetSec', () => {
  const s = emptySong({ bpm: 120, offsetSec: 0.6 });
  const ax = timeAxis(s);
  assert.equal(ax.tpb, 3840);
  assert.equal(ax.barSec(1), 0.6);
  assert.equal(ax.barSec(3), 0.6 + 4);              // 2 bars of 4/4 at 120 = 4 s
  assert.equal(ax.tickSec(960), 0.6 + 0.5);
  const six = timeAxis(emptySong({ bpm: 90, num: 6, den: 8 }));
  assert.equal(six.tpb, 2880);
  assert.ok(Math.abs(six.barSec(2) - 2) < 1e-9);      // 3 quarter notes at 90
});

test('shots play back to back; cut ones are left out', () => {
  const graph = { order: { shots: ['s01', 's02', 's03'] }, nodes: {
    s01: { label: 'S01', current: 1, versions: [{ v: 1, from_sec: 0, to_sec: 2.5 }] },
    s02: { label: 'S02', current: 1, state: 'cut', versions: [{ v: 1, from_sec: 2.5, to_sec: 4 }] },
    s03: { label: 'S03', current: 2, versions: [{ v: 1, from_sec: 4, to_sec: 6 }, { v: 2, from_sec: 0, to_sec: 3 }] } } };
  assert.deepEqual(shotTimes(graph).map((s) => [s.id, s.from, s.to]), [['s01', 0, 2.5], ['s03', 2.5, 5.5]]);
});

test('cut marks: a hit within one frame lands, one further off is "missed by", none is a plain cut', () => {
  const s = emptySong({ bpm: 120 });
  // hit planned at bar 2 (2.0 s in the music); cuts at 2.0 s (lands), 4.0 s (hit at 4.25 s: missed), 6.0 s (none)
  s.markers.push({ id: 'h01', tick: 3840, kind: 'hit', name: 'logo', sec: 2 }, { id: 'h02', tick: 3840 * 2 + 480, kind: 'hit', name: 'title', sec: 4 });
  const shots = [0, 2, 4, 6, 8].slice(0, -1).map((t, i) => ({ id: `s0${i + 1}`, from: t, to: t + 2 }));
  assert.deepEqual(cutMarks(s, shots, 30).map((c) => [c.at, c.kind, c.text]), [[2, 'hit', 'cut · hit'], [4, 'miss', 'missed by 0.25 s'], [6, 'cut', 'cut']]);
});

test('GET /music/song: a draft from the score before the import, the song after', async (t) => {
  const { tempStudio } = await import('./helpers.mjs');
  const { createProject } = await import('../src/projects.mjs');
  const { songPaths, songView } = await import('../src/song-store.mjs');
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Lane', answers: { topic: 'tides' } });
  assert.equal(songView(root, p.id), null);
  const sp = songPaths(root, p.id);
  for (const f of ['blueprint.json', 'notes.json', 'instruments.json']) cpSync(join(import.meta.dirname, 'fixtures', 'songs', 'four', f), join(sp.music, f));
  const draft = songView(root, p.id);
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.song.patterns.map((x) => x.id), ['m01', 'm02']);
  assert.equal(draft.song.patterns[0].notes.ch02.length, 13);
  // the notes of every chord in the chart, for the Piano roll's lit rows
  const chart = JSON.parse(readFileSync(join(sp.music, 'blueprint.json'), 'utf8')).chart;
  for (const sym of chart.flatMap((r) => r.chords.flat())) assert.ok(draft.fits[sym]?.tones.length >= 3, sym);
});

test('Piano roll: the chords of each bar and the rows that fit them (chord tones 2, tensions 1)', async () => {
  const { chordsFor, fitOf } = await import('../web/pianoroll.js');
  const chart = [{ bars: [1, 2], chords: ['Am'] }, { bars: [3, 6], chords: ['F', ['G', 'C']] }];
  assert.deepEqual(chordsFor(chart, 1, 6), [['Am'], ['Am'], ['F'], ['G', 'C'], ['F'], ['G', 'C']]);
  assert.deepEqual(chordsFor(chart, 7, 1), [[]]);
  const fits = { Am: { tones: [9, 0, 4], tens: [2, 5] } };
  assert.deepEqual([57, 60, 64, 62, 65, 61].map((k) => fitOf(fits, 'Am', k)), [2, 2, 2, 1, 1, 0]);
  assert.equal(fitOf(fits, 'Bb', 58), 0, 'a chord the service had no notes for lights nothing');
});

test('the sync rule: play at 1 under 10 ms, nudge 0.95–1.05 up to 120 ms, seek beyond', async () => {
  const { syncAction } = await import('../web/transport.js');
  assert.deepEqual(syncAction(0.004), { rate: 1 });
  assert.deepEqual(syncAction(-0.009), { rate: 1 });
  assert.ok(Math.abs(syncAction(0.05).rate - 0.95) < 1e-9, 'picture 50 ms ahead: slow to 0.95');
  assert.ok(Math.abs(syncAction(-0.02).rate - 1.02) < 1e-9, 'picture 20 ms behind: speed to 1.02');
  assert.equal(syncAction(0.1).rate, 0.95);
  assert.equal(syncAction(-0.12).rate, 1.05);
  assert.deepEqual(syncAction(0.121), { seek: true });
  assert.deepEqual(syncAction(-2), { seek: true });
  for (let e = -0.12; e <= 0.12; e += 0.001) { const r = syncAction(e).rate; assert.ok(r >= 0.95 && r <= 1.05); }
});

test('Piano roll: the scale\'s rows and the range shown (the part\'s notes ± 2, at least 2 octaves)', async () => {
  const { scaleClasses, keyRange } = await import('../web/pianoroll.js');
  assert.deepEqual([...scaleClasses({ root: 'D', mode: 'dorian' })].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual([...scaleClasses({ root: 'A', mode: 'minor' })].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual([...scaleClasses({ root: 'E', mode: 'phrygian' })].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  assert.equal(scaleClasses(null), null);
  const [lo, hi] = keyRange([{ key: 40 }, { key: 43 }]);
  assert.ok(hi - lo >= 24 && lo <= 38 && hi >= 45, `${lo}–${hi}`);
  assert.deepEqual(keyRange([{ key: 30 }, { key: 70 }]), [28, 72]);
});
