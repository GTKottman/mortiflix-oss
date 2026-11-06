// Music cues: plan, make (cost first, logged, billing stop), mix. No network: fetch is mocked, audio is ffmpeg sine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { saveConfig, writeSecret } from '../src/studio.mjs';
import { projectPaths } from '../src/projects.mjs';
import { musicHandlers, normalizeCues, duckExpression, speechRegions, creditsFor } from '../src/svc/elmusic.mjs';

class PE extends Error { constructor(code, message) { super(message); this.code = code; } }
const ID = 'music-test';
const sine = (file, sec, hz) => { mkdirSync(join(file, '..'), { recursive: true }); const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${sec}`, '-ar', '44100', file]); assert.equal(r.status, 0, 'ffmpeg sine'); };

function setup(t, { music = true, fetchFn } = {}) {
  const root = tempStudio(t);
  saveConfig(root, { voice: { engine: 'elevenlabs', elevenlabs: { music } } });
  writeSecret(root, 'elevenlabs_api_key', 'test-key');
  const work = projectPaths(root, ID).work;
  mkdirSync(join(work, 'voice'), { recursive: true }); mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: 'Hello there.' }, { id: 'b02', words: 'Now it gets dark.' }, { id: 'b03', words: 'Morning comes.' }] }));
  const w = (id, s, e) => ({ id, start: s, end: e, words: [{ text: 'x', start: s, end: (s + e) / 2 }, { text: 'y', start: (s + e) / 2, end: e }] });
  writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify({ seconds: 20, lines: [w('b01-1', 0.5, 6), w('b02-1', 7, 13), w('b03-1', 14, 19.5)] }));
  const calls = [];
  const fx = fetchFn || (async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, arrayBuffer: async () => readFileSync(join(work, 'fx.mp3')).buffer.slice(0) }; });
  sine(join(work, 'fx.mp3'), 12, 330);
  const h = musicHandlers({ root, ProtocolError: PE, needProject: () => ID, fetchFn: fx, ask: async () => JSON.stringify({ cues: [
    { from_sec: 0, to_sec: 7, mood: 'calm', prompt: 'soft piano, no vocals', energy: 0.3, crossfade_sec: 1, duck_db: -10 },
    { from_sec: 7, to_sec: 14, mood: 'dark', prompt: 'low drone', energy: 0.6, crossfade_sec: 2, duck_db: -9 },
    { from_sec: 14, to_sec: 20, mood: 'relief', prompt: 'warm pads', energy: 0.4, crossfade_sec: 1, duck_db: -9 }] }) });
  return { root, work, h, calls };
}

test('plan: cues cover the video, cut at scene starts, stored in music/cues.json', async (t) => {
  const { h, work } = setup(t);
  const p = await h['music.plan.make']({});
  assert.equal(p.source, 'ai');
  assert.deepEqual(p.cues.map((c) => [c.id, c.from_sec, c.to_sec]), [['mc01', 0, 7], ['mc02', 7, 14], ['mc03', 14, 20]]);
  assert.ok(existsSync(join(work, 'music', 'cues.json')));
  assert.equal((await h['music.plan.get']({})).cues.length, 3);
});

test('plan: when the AI gives nothing the script still gets cues (source beats)', async (t) => {
  const { root, h } = setup(t);
  const h2 = musicHandlers({ root, ProtocolError: PE, needProject: () => ID, ask: async () => '' });
  const p = await h2['music.plan.make']({});
  assert.equal(p.source, 'beats'); assert.ok(p.cues.length >= 1);
  assert.equal(p.cues.at(-1).to_sec, 20); assert.equal(p.cues[0].from_sec, 0);
  assert.ok(h);
});

test('normalize snaps to scene starts and drops cues under 3 s', () => {
  const spans = [{ id: 'b01', from: 0.5, to: 6 }, { id: 'b02', from: 7, to: 13 }];
  const c = normalizeCues([{ from_sec: 0 }, { from_sec: 7.2 }, { from_sec: 8.1 }], spans, 20);
  assert.deepEqual(c.map((x) => [x.from_sec, x.to_sec]), [[0, 7], [7, 20]]);
});

test('make: estimate first, then the call; every call logged', async (t) => {
  const { h, work, calls } = setup(t);
  await h['music.plan.make']({});
  const est = await h['music.cue.make']({ cue: 'mc01' });
  assert.equal(est.needs_confirm, true); assert.equal(est.credits_estimate, creditsFor(8)); assert.equal(calls.length, 0);
  const r = await h['music.cue.make']({ cue: 'mc01', confirm: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/music/); assert.equal(calls[0].body.music_length_ms, 8000); assert.equal(calls[0].body.force_instrumental, true);
  assert.equal(r.cue.state, 'made'); assert.ok(existsSync(join(work, 'music', 'mc01.mp3')));
  const log = readFileSync(join(work, 'music', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 1); assert.equal(log[0].ok, true);
  assert.equal((await h['music.cue.ok']({ cue: 'mc01' })).cue.state, 'ok');
});

test('make: 402 stops at once with no retry; 500 retries once', async (t) => {
  let n = 0;
  const bill = setup(t, { fetchFn: async (url) => { if (/subscription/.test(url)) return { ok: false, status: 404 }; n++; return { ok: false, status: 402, text: async () => 'quota' }; } });
  await bill.h['music.plan.make']({});
  await assert.rejects(bill.h['music.cue.make']({ cue: 'mc01', confirm: true }), (e) => e.code === 'billing');
  assert.equal(n, 1);
  let m = 0;
  const flaky = setup(t, { fetchFn: async (url) => { if (/subscription/.test(url)) return { ok: false, status: 404 }; m++; return { ok: false, status: 500, text: async () => 'oops' }; } });
  await flaky.h['music.plan.make']({});
  await assert.rejects(flaky.h['music.cue.make']({ cue: 'mc01', confirm: true }), (e) => e.code === 'failed');
  assert.equal(m, 2);
  assert.equal(readFileSync(join(flaky.work, 'music', 'calls.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('make: refuses when Eleven Music is off; set marks made music stale', async (t) => {
  const off = setup(t, { music: false });
  await off.h['music.plan.make']({});
  await assert.rejects(off.h['music.cue.make']({ cue: 'mc01', confirm: true }), (e) => e.code === 'music_off');
  const on = setup(t);
  await on.h['music.plan.make']({});
  await on.h['music.cue.make']({ cue: 'mc01', confirm: true });
  const s = await on.h['music.cue.set']({ cue: 'mc01', prompt: 'new words' });
  assert.equal(s.cue.state, 'stale');
  await assert.rejects(async () => on.h['music.cue.ok']({ cue: 'mc02' }), (e) => e.code === 'not_made');
});

test('duck expression eases down while the voice speaks', () => {
  const r = speechRegions({ lines: [{ words: [{ start: 1, end: 2 }, { start: 2.2, end: 3 }, { start: 9, end: 10 }] }] });
  assert.equal(r.length, 2);
  assert.match(duckExpression(r, -12), /^\(1-0\.7\d+\*max\(/);
  assert.equal(duckExpression([], -12), '1');
});

test('mix: narration + 3 cues, ducked and crossfaded, -14 LUFS wav (ffmpeg, no network)', async (t) => {
  const { h, work } = setup(t);
  sine(join(work, 'out', 'voice', 'narration.wav'), 20, 880);
  await h['music.plan.make']({});
  for (const c of ['mc01', 'mc02', 'mc03']) await h['music.cue.make']({ cue: c, confirm: true });
  const r = await h['music.mix']({});
  assert.ok(existsSync(r.path));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', r.path], { encoding: 'utf8' });
  assert.ok(Math.abs(Number(probe.stdout) - 20) < 0.3, `duration ${probe.stdout}`);
  const ln = spawnSync('ffmpeg', ['-nostdin', '-i', r.path, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const lufs = Number([...ln.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)[1]);
  assert.ok(Math.abs(lufs + 14) < 1.5, `LUFS ${lufs}`);
});

test('mix: no music or no narration is a clear refusal', async (t) => {
  const { h } = setup(t);
  await h['music.plan.make']({});
  await assert.rejects(h['music.mix']({}), (e) => e.code === 'no_music');
});
