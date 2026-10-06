import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { hapsToChannels, checkBlueprint, checkScore, intensity, timeOf } from '../pipelines/_shared/skills/music/lib/score.mjs';
import { checkHarmony } from '../pipelines/_shared/skills/music/lib/harmony.mjs';
import { writeMidi, readMidi } from '../pipelines/_shared/skills/music/lib/midi.mjs';
import * as setup from '../src/setup.mjs';
import { validatePipeline } from '../src/pipelines.mjs';
import { createProject, startProject, loadProject, projectPipeline } from '../src/projects.mjs';
import { stepView } from '../src/gates.mjs';
import { prepareWorkdir, writeTorch } from '../src/torch.mjs';
import { projectPaths } from '../src/projects.mjs';

const REPO = resolve(import.meta.dirname, '..');

// An 8-bar cue in 4/4 at 120 BPM: 2 s a bar. Bars 1-4 quiet, 5-8 lifted, a hit at 8 s (bar 5).
const BP = {
  title: 'Test', bpm: 120, meter: '4/4', bars: 8, scale: 'A:minor', offset_sec: 0,
  sections: [
    { name: 'Low glow', start_bar: 1, end_bar: 4, function: 'establish: bass and pad alone', intensity: 2 },
    { name: 'The lift', start_bar: 5, end_bar: 8, function: 'release: drums and hook arrive', intensity: 8 },
  ],
  hits: [{ t_sec: 8, bar: 5, beat: 1, kind: 'direct', what: 'logo lands' }],
  chart: [{ bars: [1, 8], chords: ['Am7', 'Fmaj7', 'C', 'G'] }],
  roles: [{ channel: 1, harmony: 'bass', name: 'Bass' }, { channel: 2, harmony: 'melody', name: 'Hook' }, { channel: 10, harmony: 'drums', name: 'Drums' }],
};
const ROOTS = ['a1', 'f1', 'c2', 'g1'];
const hap = (bar, beat, dur, value) => ({ begin: bar - 1 + (beat - 1) / 4, end: bar - 1 + (beat - 1 + dur) / 4, value });
function cueHaps({ hook = 'c5', late = false } = {}) {
  const h = [];
  for (let b = 1; b <= 8 + (late ? 1 : 0); b++) h.push(hap(b, 1, 4, { note: ROOTS[(b - 1) % 4], midichan: 1, velocity: 0.8 }));
  for (let b = 5; b <= 8; b++) {
    for (let k = 1; k <= 4; k++) h.push(hap(b, k, 1, { note: (b - 1) % 4 === 0 ? 'e5' : (b - 1) % 4 === 1 ? 'a4' : (b - 1) % 4 === 2 ? hook : 'd5', midichan: 2, velocity: 0.7 + k * 0.05 }));
    for (let k = 1; k <= 8; k++) h.push(hap(b, 1 + (k - 1) / 2, 0.25, { note: k % 2 ? 36 : 42, midichan: 10, velocity: 0.9 }));
  }
  return h;
}
const manifestOf = (ch) => ({ bpm: ch.bpm, meter: '4/4', beats_per_bar: 4, bars: 8, tracks: ch.tracks.map((t) => ({ ...t, notes: t.notes.filter((n) => n.start < 32) })) });

test('music: a cue that ends, lands its hit and builds where it should passes', () => {
  assert.deepEqual(checkBlueprint(BP), []);
  const ch = hapsToChannels({ haps: cueHaps(), cps: 0.5, beatsPerCycle: 4, names: { 1: 'Bass', 2: 'Hook', 10: 'Drums' } });
  assert.equal(ch.bpm, 120);
  assert.deepEqual(ch.problems, []);
  const score = checkScore(ch, BP, { video_sec: 16 });
  assert.deepEqual(score.errors, []);
  assert.equal(score.hits[0].music_sec, 8);
  assert.equal(timeOf(BP, 5), 8);
  assert.deepEqual(intensity(manifestOf(ch), BP).problems, []);
  assert.equal(checkHarmony(manifestOf(ch), BP).ok, true);
});

test('music: the check catches looping past the end, a missed hit, a flat build and a wrong note', () => {
  const ch = hapsToChannels({ haps: cueHaps({ late: true }), cps: 0.5, beatsPerCycle: 4, names: { 1: 'Bass', 2: 'Hook', 10: 'Drums' } });
  assert.match(checkScore(ch, BP).errors.join('\n'), /Bass keeps playing after the last bar/);
  const offHit = checkScore(ch, { ...BP, hits: [{ t_sec: 8.5, bar: 5, beat: 1, what: 'late logo' }] });
  assert.match(offHit.errors.join('\n'), /late logo.*more than a frame off/);
  const flat = intensity(manifestOf(ch), { ...BP, sections: [{ ...BP.sections[0], intensity: 9 }, { ...BP.sections[1], intensity: 1 }] });
  assert.match(flat.problems[0], /"Low glow" was asked to be more intense/);
  const sour = hapsToChannels({ haps: cueHaps({ hook: 'c#5' }), cps: 0.5, beatsPerCycle: 4 });
  const h = checkHarmony(manifestOf(sour), BP);
  assert.equal(h.ok, false);
  assert.ok(h.counts['out of key and not in the chord'] >= 1);
  assert.match(checkBlueprint({ ...BP, sections: [{ ...BP.sections[0], end_bar: 3 }, BP.sections[1]] }).join('\n'), /starts at bar 5; it should start at 4/);
  const noChan = hapsToChannels({ haps: [hap(1, 1, 1, { note: 'a3' })], cps: 0.5 });
  assert.match(noChan.problems[0], /no \.midichan/);
});

test('music: the MIDI pack keeps each part on its role channel, with tempo, meter and markers', () => {
  const ch = hapsToChannels({ haps: cueHaps(), cps: 0.5, beatsPerCycle: 4, names: { 1: 'Bass', 2: 'Hook', 10: 'Drums' } });
  const buf = writeMidi({ bpm: 120, meter: '3/4', tracks: ch.tracks, markers: [{ beat: 16, text: 'HIT logo lands' }] });
  const r = readMidi(buf);
  assert.equal(r.tempo, 500000);
  assert.deepEqual(r.tracks.slice(1).map((t) => t.name), ['Bass', 'Hook', 'Drums']);
  assert.equal(r.tracks[1].notes[0].channel, 0);
  assert.equal(r.tracks[2].notes[0].channel, 1);
  assert.equal(r.tracks[3].notes[0].channel, 9);
  assert.ok(buf.includes(Buffer.from('HIT logo lands')));
});

test('setup: asset sites are web addresses without logins; music choices persist', (t) => {
  const root = tempStudio(t);
  assert.deepEqual(setup.saveAssetSites(root, ['stock.example.com/', { url: 'https://img.example.org/x', notes: 'photos' }, 'stock.example.com']).sites,
    [{ url: 'https://stock.example.com', notes: '' }, { url: 'https://img.example.org/x', notes: 'photos' }]);
  assert.throws(() => setup.saveAssetSites(root, ['https://me:pw@stock.example.com']), /leave logins out/);
  assert.throws(() => setup.saveAssetSites(root, ['ftp://files.example.com']), /http and https/);
  assert.deepEqual(setup.musicConfig({}), { engine: 'strudel', midi: false });
  assert.deepEqual(setup.saveMusic(root, { midi: true }), { engine: 'strudel', midi: true });
  assert.throws(() => setup.saveMusic(root, { engine: 'kazoo' }), /strudel or none/);
  const env = setup.sessionToolsEnv(root);
  assert.equal(JSON.parse(env.MFX_MUSIC).midi, true);
  assert.equal(JSON.parse(env.MFX_ASSETS).sites.length, 2);
});

test('pipelines: "when" is checked, and a skipped music step never lets later work jump ahead', (t) => {
  assert.match(validatePipeline({ slug: 'x', name: 'X', steps: [{ key: 'a', review: 'video', when: 'rain' }] }).join('\n'), /"when" must be one of music/);
  const root = tempStudio(t);
  const quiet = createProject(root, { pipeline: 'explainer', title: 'Quiet', answers: { topic: 'bikes', music: 'No music' } });
  startProject(root, quiet.id);
  const view = stepView(loadProject(root, quiet.id), projectPipeline(root, quiet.id));
  const state = Object.fromEntries(view.map((s) => [s.key, s.state]));
  assert.equal(state.music, 'skipped');
  assert.equal(state.build, 'blocked');   // still waits for the animatic
  const scored = createProject(root, { pipeline: 'explainer', title: 'Scored', answers: { topic: 'bikes' } });
  startProject(root, scored.id);
  assert.equal(stepView(loadProject(root, scored.id), projectPipeline(root, scored.id)).find((s) => s.key === 'music').state, 'blocked');
  setup.saveMusic(root, { engine: 'none' });
  const off = createProject(root, { pipeline: 'explainer', title: 'Studio says none', answers: { topic: 'bikes' } });
  startProject(root, off.id);
  assert.equal(stepView(loadProject(root, off.id), projectPipeline(root, off.id)).find((s) => s.key === 'music').state, 'skipped');
  // The session brief says what the studio has, and no studio skills arrive without their setup.
  prepareWorkdir(root, off.id);
  writeTorch(root, off.id, { backend: 'demo', reason: 'test' });
  const md = readFileSync(join(projectPaths(root, off.id).work, 'CLAUDE.md'), 'utf8');
  assert.match(md, /\*\*Music:\*\* the owner chose no music/);
  assert.match(md, /\*\*Asset sites:\*\* none/);
  const skills = readdirSync(join(projectPaths(root, off.id).work, '.claude', 'skills'));
  assert.ok(skills.includes('music') && !skills.includes('assets') && !skills.includes('blender-3d'));
});

// A real render, only where Strudel and Chrome are installed (MFX_TEST_STRUDEL=<a studio's tools/strudel>).
test('music: strudel.mjs checks, renders and exports a real cue', { skip: !process.env.MFX_TEST_STRUDEL && 'set MFX_TEST_STRUDEL to run' }, (t) => {
  const chrome = setup.setupStatusSync(tempStudio(t)).chrome;
  if (!chrome.ok) return t.skip('no Chrome');
  const dir = mkdtempSync(join(tmpdir(), 'mfx-cue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'music'));
  writeFileSync(join(dir, 'music', 'blueprint.json'), JSON.stringify(BP));
  writeFileSync(join(dir, 'music', 'score.strudel.js'), `setcpm(120 / 4)
const cue = (p) => p.filterWhen((t) => t < 8)
const lift = "<0!4 1!4>"
bass: cue(note("<a1 f1 c2 g1>").s("sawtooth").lpf(500).velocity(.8)).midichan(1)
hook: cue(note("<[e5 e5 e5 e5] [a4 a4 a4 a4] [c5 c5 c5 c5] [d5 d5 d5 d5]>").s("square").velocity(".75 .8 .85 .9").gain(.2).mask(lift)).midichan(2)
drums: cue(note("36 42 36 42 36 42 36 42").s("sine").decay(.1).sustain(0).velocity(.9).mask(lift)).midichan(10)
`);
  const env = { ...process.env, MFX_STRUDEL: process.env.MFX_TEST_STRUDEL, MFX_CHROME: chrome.path };
  const tool = join(REPO, 'pipelines/_shared/skills/music/strudel.mjs');
  const run = (...args) => spawnSync('node', [tool, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
  const check = run('check', '--video-sec', '16');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /Check passed/);
  assert.equal(run('render').status, 0);
  assert.ok(existsSync(join(dir, 'out/music/score.wav')));
  assert.equal(run('midi').status, 0);
  assert.ok(existsSync(join(dir, 'out/music/midi/CUE-SHEET.md')));
});
