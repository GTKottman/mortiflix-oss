// The music engine's stages that need no Strudel (instruments, the genre profile, the owner's master, sharing a
// pipeline), plus one real run of every stage where Strudel and Chrome are installed (MFX_TEST_STRUDEL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { checkInstruments, instrumentCode, registers } from '../pipelines/_shared/skills/music/lib/instruments.mjs';
import { profileProblems, signatureProblems } from '../pipelines/_shared/skills/music/lib/genre.mjs';
import { readWav, mixBalance } from '../pipelines/_shared/skills/music/lib/wav.mjs';
import { zip, unzip } from '../src/zip.mjs';
import { exportPipeline, addPipeline, listPipelines } from '../src/pipelines.mjs';
import { createProject, startProject, projectPaths, loadProject } from '../src/projects.mjs';
import { importMaster, midiPack, finishesOwnMaster, musicStatus } from '../src/music.mjs';
import * as setup from '../src/setup.mjs';

const REPO = resolve(import.meta.dirname, '..');
const scratch = (t) => { const d = mkdtempSync(join(tmpdir(), 'mfx-music-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const ffmpeg = (...args) => spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);

// The captured MIDI of a small piece: a bass, a pad and a hook in different registers, drums on 10.
const n = (pitch, start, dur = 1) => ({ pitch, start, dur, velocity: 0.8 });
const MANIFEST = { bpm: 96, beats_per_bar: 4, bars: 4, tracks: [
  { channel: 1, name: 'Sub', kind: 'pitched', notes: [n(33, 0, 4), n(29, 4, 4), n(36, 8, 4), n(31, 12, 4)] },
  { channel: 2, name: 'Pad', kind: 'pitched', notes: [n(57, 0, 4), n(60, 0, 4), n(64, 0, 4), n(55, 8, 4), n(60, 8, 4)] },
  { channel: 3, name: 'Hook', kind: 'pitched', notes: [n(76, 0), n(72, 1), n(69, 2), n(79, 3)] },
  { channel: 10, name: 'Drums', kind: 'drums', notes: [n(36, 0), n(38, 1), n(42, 0.5), n(42, 1.5)] },
] };
const INST = { concept: 'A sub, a soft pad, a glass bell and a dry kit.', parts: [
  { channel: 1, role: 'Sub', sound: 'sine', set: '.lpf(300)', gain: 0.8, pan: 0, character: 'dark', why: 'the floor' },
  { channel: 2, role: 'Pad', sound: 'triangle', set: '.attack(.3).release(1).room(.4)', gain: 0.35, pan: -0.3, character: 'warm', why: 'the fog' },
  { channel: 3, role: 'Hook', sound: 'sine', set: '.fm(3).fmh(3.5).decay(.4)', gain: 0.3, pan: 0.4, character: 'bright', why: 'glass' },
  { channel: 10, role: 'Drums', gain: 0.9, why: 'dry', kit: { 36: { sound: 'sine', set: '.penv(24).decay(.2).sustain(0)' }, 38: { sound: 'pink', set: '.decay(.1).sustain(0)' }, 42: { sound: 'white', set: '.hpf(7000).decay(.03)', gain: 0.3 } } },
] };
const clone = (x) => JSON.parse(JSON.stringify(x));

test('instruments: a palette that covers every channel passes; the palette rules catch what they promise', () => {
  const ok = checkInstruments(INST, MANIFEST);
  assert.deepEqual(ok.errors, []);
  assert.equal(registers(MANIFEST).find((r) => r.channel === 10).drums.join(' '), '36 38 42');

  const missing = clone(INST); missing.parts = missing.parts.filter((p) => p.channel !== 2);
  assert.match(checkInstruments(missing, MANIFEST).errors.join('\n'), /channel 2 \(Pad\) plays 5 notes but has no instrument/);

  const kit = clone(INST); delete kit.parts[3].kit['42'];
  assert.match(checkInstruments(kit, MANIFEST).errors.join('\n'), /General MIDI 42 but the kit has no sound/);

  // Two parts in one register with the same kind of sound: one has to change.
  const clash = clone(MANIFEST); clash.tracks[2].notes = [n(57, 0), n(59, 1), n(60, 2), n(60, 3)];
  const same = clone(INST); same.parts[1].sound = 'sine'; same.parts[1].set = '.fm(2)';
  assert.match(checkInstruments(same, clash).errors.join('\n'), /Pad and Hook play in the same register .* same kind of sound \(fm-sine\)/);

  const lofi = clone(INST); lofi.parts[0].character = 'lofi'; lofi.parts[1].character = 'lofi';
  assert.match(checkInstruments(lofi, MANIFEST).errors.join('\n'), /2 parts are "lofi"/);

  // A sound can't change the notes, and "set" is a method chain, never code.
  const notes = clone(INST); notes.parts[2].set = '.note(60)';
  assert.match(checkInstruments(notes, MANIFEST).errors.join('\n'), /can't change the notes/);
  const code = clone(INST); code.parts[0].set = '.lpf(300); fetch("x")';
  assert.match(checkInstruments(code, MANIFEST).errors.join('\n'), /method chain only/);
  const sample = clone(INST); sample.parts[1].sound = 'gm_pad_warm';
  assert.match(checkInstruments(sample, MANIFEST).errors.join('\n'), /needs "source"/);
});

test('instruments: the Strudel layer gives every channel its sound, level, pan and own bus, without double-quoted keys', () => {
  const code = instrumentCode(INST);
  assert.match(code, /1: \(p\) => p\.s\("sine"\)\.lpf\(300\)\.gain\(0\.8\)\.pan\(0\.5\)/);
  assert.match(code, /2: \(p\) => p\.s\("triangle"\).*\.pan\(0\.35\)/);
  assert.match(code, /drumOf\(v\) === 42\)\.s\("white"\)\.hpf\(7000\)\.decay\(\.03\)\.gain\(0\.27\)/);   // part gain × kit gain
  assert.match(code, /\.orbit\(Number\(ch\)\)/);
  // Strudel reads "double-quoted" text as mini-notation: the drum map must use single quotes.
  assert.doesNotMatch(code.split('\n').find((l) => l.includes('const drumOf')), /"/);
});

const PROFILE = {
  name: 'Trip hop', summary: 'A slow, moody fusion of hip hop beats and electronic textures that came out of Bristol in the early nineties, built for headphones.',
  meaning: 'It expresses urban melancholy and late-night introspection: hip hop production techniques slowed down and soaked in dub, soul and film-score atmosphere by a scene of sound systems and producers.',
  tempo: { min: 70, max: 100, typical: 88 }, meters: ['4/4'], feel: 'straight 16ths with a lazy, behind-the-beat swing',
  lineup: [{ role: 'Breakbeat drums', harmony: 'drums', job: 'the slow heavy groove' }, { role: 'Dub bass', harmony: 'bass', job: 'deep roots under the break' }, { role: 'Strings', harmony: 'chords', job: 'cinematic sustained harmony' }],
  beat: { description: 'a slow breakbeat with a heavy kick and ghosted snares', grids: [{ name: 'Main', steps: 16, parts: { kick: 'x.....x...x.....', snare: '....X.......X..g' } }] },
  bass: 'long dub notes that sit on the root and slide between chords', harmony: { modes: ['minor'], progressions: ['i - VI'] }, hook: { traits: ['a short sad phrase that repeats'] },
  arrangement: 'long intros, a groove that builds by adding layers, breakdowns to strings',
  length: { min_sec: 200, max_sec: 360, typical_sec: 270 },
  unforgettable: ['dusty-break:beat', 'dub-bass:bass', 'string-swell:texture', 'sad-phrase:hook', 'vinyl:texture'].map((x) => { const [id, area] = x.split(':'); return { id, area, element: id.replace('-', ' '), why: 'it is what listeners remember', how: 'written exactly like this in the score, on its channel' }; }),
  avoid: ['too fast', 'clean digital drums'], references: [{ artist: 'A', title: 'x' }, { artist: 'B', title: 'y' }],
  sources: [1, 2, 3, 4, 5].map((i) => ({ url: `https://example.org/trip-hop/${i}`, title: `Source ${i}` })),
};

test('genre: a profile is complete only with 5 sources read and hook and beat elements; the blueprint signature uses them', () => {
  assert.deepEqual(profileProblems(PROFILE), []);
  const thin = { ...PROFILE, sources: PROFILE.sources.slice(0, 3) };
  assert.match(profileProblems(thin).join('\n'), /at least 5 different web pages/);
  const noHook = { ...PROFILE, unforgettable: PROFILE.unforgettable.filter((e) => e.area !== 'hook') };
  assert.match(profileProblems(noHook).join('\n'), /element for the hook/);
  assert.deepEqual(signatureProblems([{ id: 'sad-phrase', carries: 'hook', how: 'on the hook, every return', where: 'bars 9-32' }, { id: 'dusty-break', carries: 'beat', how: 'half-time from bar 9', where: 'bars 9-32' }], PROFILE), []);
  assert.match(signatureProblems([{ id: 'banjo', carries: 'hook', how: 'on the hook, every return', where: 'all' }], PROFILE).join('\n'), /"banjo" is not an element/);
});

test('mix balance: a sub-heavy mix reads as low end; a mono one as narrow', (t) => {
  const d = scratch(t);
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=55:duration=2', '-ac', '2', join(d, 'low.wav'));
  const b = mixBalance(readWav(join(d, 'low.wav')));
  assert.ok(b.lowPct > 90, `low end ${b.lowPct}%`);
  assert.ok(b.widthDb < -60, `width ${b.widthDb}`);
  assert.match(b.notes.join('\n'), /narrow/);
});

test('zip: what is written reads back, names and bytes', () => {
  const files = [{ name: 'midi/01-sub.mid', data: Buffer.from([0x4d, 0x54, 0x68, 0x64]) }, { name: 'MUSIC-SHEET.md', data: Buffer.from('# x\n') }];
  assert.deepEqual(unzip(zip(files)).map((f) => [f.name, f.data.toString('hex')]), files.map((f) => [f.name, f.data.toString('hex')]));
});

test('sharing: a pipeline exports with its skills and adds back; unsafe paths and silent replacement are refused', (t) => {
  const root = tempStudio(t);
  const x = exportPipeline(root, 'song');
  const names = unzip(x.zip).map((f) => f.name);
  assert.ok(names.includes('song/pipeline.json') && names.includes('song/skills/music/strudel.mjs'), names.join(' '));
  assert.ok(!JSON.parse(unzip(x.zip).find((f) => f.name === 'song/pipeline.json').data).shared_skills, 'self-contained');
  const r = addPipeline(root, x.zip);
  assert.equal(r.slug, 'song'); assert.ok(r.overrides_built_in); assert.ok(r.scripts.includes('skills/music/strudel.mjs'));
  assert.equal(listPipelines(root).find((p) => p.slug === 'song').source, 'studio');
  assert.throws(() => addPipeline(root, x.zip), /already has a pipeline "song"/);
  assert.ok(addPipeline(root, x.zip, { replace: true }).replaced);
  const evil = zip([...unzip(x.zip), { name: 'song/../../escape.txt', data: Buffer.from('x') }]);
  assert.throws(() => addPipeline(root, evil, { replace: true }), /unsafe path/);
  assert.ok(!existsSync(join(root, 'escape.txt')));
});

test('a music pipeline needs the studio\'s music on', (t) => {
  const root = tempStudio(t, { music: { engine: 'none' } });
  const { id } = createProject(root, { pipeline: 'song', title: 'S', answers: { genre: 'trip hop', topic: 'a harbour' } });
  assert.throws(() => startProject(root, id), /music is off/);
});

test('your own master: the MIDI pack goes out, a master that fits comes in (and a short one is refused)', async (t) => {
  const root = tempStudio(t);
  const { id } = createProject(root, { pipeline: 'explainer', title: 'E', answers: { topic: 'x', music: 'Original score: I finish it from the MIDI (recommended)' } });
  assert.ok(finishesOwnMaster(loadProject(root, id)));
  assert.ok(!finishesOwnMaster({ intake: { answers: { music: 'Original score, rendered by Strudel' } } }));
  const w = projectPaths(root, id).work;
  mkdirSync(join(w, 'music'), { recursive: true }); mkdirSync(join(w, 'out/music/midi'), { recursive: true });
  // 4 bars at 120 BPM = 8 s, the first note on beat 2 (0.5 s).
  writeFileSync(join(w, 'music/blueprint.json'), JSON.stringify({ title: 'Cue', bpm: 120, meter: '4/4', bars: 4 }));
  writeFileSync(join(w, 'music/notes.json'), JSON.stringify({ tracks: [{ channel: 1, notes: [{ pitch: 45, start: 1, dur: 4, velocity: 0.8 }] }] }));
  writeFileSync(join(w, 'out/music/midi/01-bass.mid'), 'MThd');
  assert.deepEqual(unzip(midiPack(root, id)).map((f) => f.name), ['midi/01-bass.mid']);
  assert.equal(musicStatus(root, id).finish, 'own');

  const d = scratch(t);
  ffmpeg('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=0.5', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=9', '-filter_complex', '[0][1]concat=n=2:v=0:a=1', join(d, 'fits.flac'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', join(d, 'short.wav'));
  const short = await importMaster(root, id, { file: join(d, 'short.wav') });
  assert.equal(short.ok, false); assert.match(short.errors.join(), /score runs 8.00 s/);
  const r = await importMaster(root, id, { file: join(d, 'fits.flac') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(r.measured.offset_sec) < 0.05, `starts with bar 1 (offset ${r.measured.offset_sec})`);
  assert.ok(existsSync(join(w, 'music/own-master/master.wav')));
  assert.equal(JSON.parse(readFileSync(join(w, 'music/own-master/report.json'))).source, 'fits.flac');
  await assert.rejects(importMaster(root, id, { file: join(d, 'notes.txt') }), /import an audio file/);
});

// Every stage for real, where Strudel and Chrome are installed (MFX_TEST_STRUDEL=<a studio's tools/strudel>).
test('music engine: plan, check + MIDI, instruments, audition and master on a real song', { skip: !process.env.MFX_TEST_STRUDEL && 'set MFX_TEST_STRUDEL to run' }, (t) => {
  const chrome = setup.setupStatusSync(tempStudio(t)).chrome;
  if (!chrome.ok) return t.skip('no Chrome');
  const dir = scratch(t); mkdirSync(join(dir, 'music'));
  writeFileSync(join(dir, 'music/blueprint.json'), JSON.stringify({ title: 'Glass Harbour', bpm: 96, meter: '4/4', bars: 8, scale: 'A:minor',
    sections: [{ name: 'Fog on the water', start_bar: 1, end_bar: 4, function: 'establish: bass and pad alone', intensity: 2 }, { name: 'The lamp turns', start_bar: 5, end_bar: 8, function: 'release: drums and the hook arrive', intensity: 8 }],
    chart: [{ bars: [1, 8], chords: ['Am7', 'Fmaj7', 'C', 'G'] }],
    roles: [{ channel: 1, harmony: 'bass', name: 'Sub' }, { channel: 2, harmony: 'chords', name: 'Pad' }, { channel: 3, harmony: 'melody', name: 'Hook' }, { channel: 10, harmony: 'drums', name: 'Drums' }] }));
  writeFileSync(join(dir, 'music/score.strudel.js'), `setcpm(96 / 4)
const cue = (p) => p.filterWhen((t) => t < 8)
const lift = "<0!4 1!4>"
sub: cue(note("<a1 f1 c2 g1>").velocity(.8)).midichan(1)
pad: cue(note("<[a3,c4,e4,g4] [a3,c4,e4,f4] [g3,c4,e4] [g3,b3,d4]>").velocity(.6)).midichan(2)
hook: cue(note("<[e5 c5 a4 c5] [c5 a4 f5 a4] [e5 g5 e5 c5] [d5 b4 g4 b4]>").velocity("<.7 .85>").mask(lift)).midichan(3)
drums: cue(note("[36 ~ ~ 36 38 ~ 36 ~], [42*8]").velocity(.9).mask(lift)).midichan(10)
`);
  const env = { ...process.env, MFX_STRUDEL: process.env.MFX_TEST_STRUDEL, MFX_CHROME: chrome.path };
  const run = (...args) => spawnSync('node', [join(REPO, 'pipelines/_shared/skills/music/strudel.mjs'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 180_000 });
  let r = run('plan'); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('check'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(dir, 'music/notes.json')) && existsSync(join(dir, 'out/music/midi.zip')));
  r = run('instruments'); assert.equal(r.status, 1); assert.match(r.stderr, /no music\/instruments\.json yet/);
  INST.parts[2].role = 'Hook';
  writeFileSync(join(dir, 'music/instruments.json'), JSON.stringify({ ...INST, parts: INST.parts.map((p) => (p.channel === 10 ? { ...p, kit: { ...p.kit } } : p)) }));
  r = run('instruments'); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('audition'); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('master'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = JSON.parse(readFileSync(join(dir, 'music/master.json')));
  assert.ok(Math.abs(m.master.lufs + 14) <= 1 && m.master.true_peak <= -0.8, JSON.stringify(m.master));
  assert.ok(m.stems.every((s) => s.peak_db > -50), 'no silent stem (a fresh page per render)');
  assert.match(readFileSync(join(dir, 'music/MUSIC-SHEET.md'), 'utf8'), /✔ Audition · ✔ Mastered/);
});
