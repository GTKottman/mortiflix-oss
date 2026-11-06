// The replay pack generator on a tiny fixture studio made in a temp dir (ffmpeg lavfi sources): format + validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makePack, validatePack, sceneSpans } from '../tools/replay/make-pack.mjs';

const ff = (...a) => { const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
const wj = (f, o) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); };

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'replay-pack-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const studio = join(base, 'studio'), id = 'p1';
  const pd = join(studio, 'projects', id), st = join(studio, 'state', id);
  wj(join(st, 'project.json'), { title: 'Tiny', intake: { answers: { topic: 'tiny topic', audience: 'all', length: '15 s', aspect: '16:9', voice: 'Narrated' } } });
  wj(join(pd, 'script', 'beats.json'), { beats: [{ id: 'b01', name: 'One', words: 'a b' }, { id: 'b02', name: 'Two', words: 'c d' }] });
  wj(join(pd, 'script.md'), '# Tiny'); wj(join(pd, 'research', 'brief-notes.md'), 'notes');
  const mkl = (idn, start, end) => ({ id: idn, text: idn, start, end, timing: 'words', words: [{ text: 'x', start, end }] });
  const lines = [['b01-1', 0, 1.5], ['b01-2', 1.8, 3], ['b02-1', 3.4, 5.5]];
  wj(join(pd, 'voice', 'lines.json'), lines.map(([i]) => ({ id: i, text: i, script: i })));
  wj(join(pd, 'voice', 'timing.json'), { seconds: 6, lines: lines.map((l) => mkl(...l)) });
  mkdirSync(join(pd, 'out', 'voice'), { recursive: true }); mkdirSync(join(pd, 'voice', 'clips'), { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', '-ar', '48000', '-ac', '1', join(pd, 'out', 'voice', 'narration.wav'));
  for (const [i] of lines) ff('-f', 'lavfi', '-i', 'sine=frequency=400:duration=1', '-ar', '48000', join(pd, 'voice', 'clips', `${i}.wav`));
  mkdirSync(join(pd, 'design'), { recursive: true });
  for (const [n, c] of [['sf01', 'red'], ['sf02', 'blue']]) ff('-f', 'lavfi', '-i', `color=c=${c}:size=640x360`, '-frames:v', '1', join(pd, 'design', `${n}.png`));
  wj(join(pd, 'design', 'frames.json'), { frames: [
    { id: 'sf01', file: 'design/sf01.png', label: 'SF01', beats: ['b01'], name: 'Steel', palette: ['#111'], fonts: ['sans-serif'] },
    { id: 'sf02', file: 'design/sf02.png', label: 'SF02', beats: ['b02'], name: 'Steel', palette: ['#111'], fonts: ['sans-serif'] }] });
  wj(join(st, 'reviews', 'brief', 'v1', 'submission.json'), { note: 'Recorded brief.', questions: [{ id: 'pace', text: 'Calm?', choices: ['Calm', 'Fast'] }], items: [] });
  // a past project with a real-shaped animatic + score, and a tiny sfx library
  const past = join(base, 'past'), pp = join(past, 'projects', 'q1', 'out');
  mkdirSync(join(pp, 'music'), { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(pp, 'animatic.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=200:duration=3', join(pp, 'music', 'score.mp3'));
  const lib = join(base, 'sfx');
  mkdirSync(lib, { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=900:duration=0.3', join(lib, 'w.mp3'));
  wj(join(lib, 'index.json'), [{ name: 'Whoosh', prompt: 'fast whoosh', file: 'w.mp3' }]);
  return { base, studio, id, past, lib };
}

test('sceneSpans: one per beat, first at 0, LEAD before first word, last runs to narration end + 1 s', () => {
  const beats = [{ id: 'b01', name: 'A' }, { id: 'b02', name: 'B' }];
  const timing = { seconds: 6, lines: [{ id: 'b01-1', start: 0.5, words: [{ start: 0.5 }] }, { id: 'b02-1', start: 3.25, words: [{ start: 3.25 }] }] };
  const s = sceneSpans(beats, timing);
  assert.deepEqual(s.map((x) => x.beat), ['b01', 'b02']);
  assert.equal(s[0].from, 0); assert.equal(s[1].from, 3);
  assert.equal(s[0].frames + s[1].frames, 210, 'narration 6 s + 1 s hold');
});

test('makePack builds a valid mfx-replay-1 pack from a tiny studio; validatePack fails loudly on a missing clip', (t) => {
  const fx = fixture(t);
  const out = join(fx.base, 'pack');
  const p = makePack({ studio: fx.studio, project: fx.id, out, motionFrom: [`${fx.past}:q1`], sfxLibrary: fx.lib, name: 'tiny' });
  assert.equal(p.format, 'mfx-replay-1');
  assert.deepEqual(Object.keys(p.steps), ['brief', 'script', 'voice', 'style-frames']);
  assert.equal(p.project.answers.topic, 'tiny topic');
  const brief = JSON.parse(readFileSync(join(out, 'steps', 'brief', 'submission.json'), 'utf8'));
  assert.equal(brief.note, 'Recorded brief.'); assert.equal(brief.questions.length, 1);
  for (const f of ['steps/voice/work/out/voice/narration.wav', 'steps/voice/work/voice/narration.wav', 'steps/voice/work/voice/timing.json',
    'steps/script/work/script/beats.json', 'steps/style-frames/work/design/frames.json', 'motion/clips/b01.mp4', 'motion/clips/b02.mp4',
    'stills/b01-1.png', 'stills/b01-2.png', 'stills/b02-1.png', 'claude/music-plan.json', 'motion/actions.json']) assert.ok(existsSync(join(out, f)), f);
  const lines = JSON.parse(readFileSync(join(out, 'steps', 'voice', 'work', 'voice', 'lines.json'), 'utf8'));
  assert.ok(lines.every((l) => l.file === `voice/clips/${l.id}.wav`));
  const scenes = JSON.parse(readFileSync(join(out, 'motion', 'scenes.json'), 'utf8'));
  assert.deepEqual(scenes.map((s) => s.beat), ['b01', 'b02']);
  assert.ok(Math.abs(scenes.reduce((a, s) => a + s.seconds, 0) - 7) < 0.05, 'narration + 1 s hold');
  assert.equal(p.audio.sfx.length, 1); assert.equal(p.audio.music.length, 1);
  const v = validatePack(out);
  assert.equal(v.clips, 2); assert.equal(v.lines, 3);
  assert.throws(() => makePack({ studio: fx.studio, project: fx.id, out, motionFrom: [`${fx.past}:q1`], sfxLibrary: fx.lib }), /--force/);
  rmSync(join(out, 'motion', 'clips', 'b02.mp4'));
  assert.throws(() => validatePack(out), /clip b02/);
});

test('makePack without --motion-from falls back to slow-zoom of the style frame (music from --music-from)', (t) => {
  const fx = fixture(t);
  const out = join(fx.base, 'pack2');
  const p = makePack({ studio: fx.studio, project: fx.id, out, musicFrom: [`${fx.past}:q1`], sfxLibrary: fx.lib });
  assert.ok(p.source.notes.some((n) => /slow-zoom/.test(n)));
  assert.equal(validatePack(out).clips, 2);
});
