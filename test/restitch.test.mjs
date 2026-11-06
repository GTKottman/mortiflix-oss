// A pause change joins the voice again from the takes it has (svc/restitch.mjs): no ElevenLabs, words shifted, the
// music plan's cues moved with their scenes, rapid edits joined once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restitchVoice, restitchSoon, voiceStale, moveCues } from '../src/svc/restitch.mjs';

const RATE = 48000;
const ID = 'proj-restitch';

// a take: 0.1 s silence, `sec` of tone, 0.1 s silence (16-bit pcm, as ElevenLabs gives), one word over the tone
function take(dir, id, sec) {
  const n = Math.round((0.2 + sec) * RATE); const b = Buffer.alloc(n * 2);
  for (let i = Math.round(0.1 * RATE); i < Math.round((0.1 + sec) * RATE); i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  writeFileSync(join(dir, `${id}.pcm`), b);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, text: id, words: [{ text: id, start: 0.1, end: 0.1 + sec }] }));
}

function project(gaps = [0.3, 0.6, 0]) {
  const root = mkdtempSync(join(tmpdir(), 'restitch-'));
  const work = join(root, 'projects', ID);
  const takes = join(work, 'sound', 'voice', 'lines');
  mkdirSync(takes, { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true }); mkdirSync(join(root, 'state', ID), { recursive: true });
  const ids = ['b01-1', 'b01-2', 'b02-1'];
  ids.forEach((id) => take(takes, id, 0.5));
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify(ids.map((id, i) => ({ id, text: id, script: id, gap_after: gaps[i] })), null, 2));
  return { root, work, takes };
}

const wavSeconds = (f) => { const b = readFileSync(f); let o = 12; while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4); return b.readUInt32LE(o + 4) / (b.readUInt16LE(22) * (b.readUInt16LE(34) / 8)) / b.readUInt32LE(24); };

test('a pause change joins the voice from its takes: voice.wav, timing.json and the words move, no ElevenLabs', async (t) => {
  const { root, work } = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('ElevenLabs was called'); };
  t.after(() => { globalThis.fetch = real; });
  const a = await restitchVoice({ root, id: ID });
  assert.equal(a.ok, true, a.why);
  const t1 = JSON.parse(readFileSync(join(work, 'voice', 'timing.json'), 'utf8'));
  // tightened: 0.3 -> 0.1 after the first line, 0.6 -> 0.2 after the second
  const lines = JSON.parse(readFileSync(join(work, 'voice', 'lines.json'), 'utf8'));
  lines[0].gap_after = 0.1; lines[1].gap_after = 0.2;
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify(lines));
  const b = await restitchVoice({ root, id: ID });
  assert.equal(b.ok, true, b.why);
  assert.equal(b.before, t1.seconds);
  const t2 = JSON.parse(readFileSync(join(work, 'voice', 'timing.json'), 'utf8'));
  assert.ok(Math.abs((t1.seconds - t2.seconds) - 0.6) < 0.002, `${t1.seconds} -> ${t2.seconds}`);
  assert.ok(Math.abs(wavSeconds(join(work, 'voice', 'voice.wav')) - t2.seconds) < 0.002);
  assert.ok(Math.abs(wavSeconds(join(work, 'out', 'voice', 'narration.wav')) - t2.seconds) < 0.002);
  assert.equal(t2.lines[0].start, t1.lines[0].start);
  assert.ok(Math.abs((t1.lines[1].start - t2.lines[1].start) - 0.2) < 0.002);
  assert.ok(Math.abs((t1.lines[2].start - t2.lines[2].start) - 0.6) < 0.002);
  // a word keeps its place inside its line
  for (const k of [1, 2]) assert.ok(Math.abs((t2.lines[k].words[0].start - t2.lines[k].start) - (t1.lines[k].words[0].start - t1.lines[k].start)) < 0.002);
});

test('a line with no take stops the join: nothing is recorded, nothing is written', async (t) => {
  const { root, work, takes } = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(join(takes, 'b02-1.pcm'));
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('ElevenLabs was called'); };
  t.after(() => { globalThis.fetch = real; });
  const r = await restitchVoice({ root, id: ID });
  assert.equal(r.ok, false);
  assert.match(r.why, /b02-1/);
  assert.equal(existsSync(join(work, 'voice', 'voice.wav')), false);
});

test('voiceStale: lines.json newer than voice.wav', async (t) => {
  const { root, work } = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(voiceStale(work), false, 'no voice yet');
  await restitchVoice({ root, id: ID });
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(work, 'voice', 'voice.wav'), old, old);
  assert.equal(voiceStale(work), true);
  await restitchVoice({ root, id: ID });
  assert.equal(voiceStale(work), false);
});

test('rapid edits make one join, then the timeline is told', async (t) => {
  const { root } = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const emit = (e, d) => events.push([e, d]);
  for (let i = 0; i < 5; i++) restitchSoon(root, ID, { emit, wait: 30 });
  const r = await restitchSoon(root, ID, { emit, wait: 30 });
  assert.equal(r.ok, true);
  assert.deepEqual(events.map((e) => e[0]), ['node.changed']);
  assert.deepEqual(events[0][1].nodes.map((n) => n.id), ['b01-1', 'b01-2', 'b02-1']);
});

test('music cues move with their scenes; the last ends with the voice; a made cue that moved goes stale', () => {
  const before = { seconds: 20, lines: [{ id: 'b01-1', start: 0, end: 4 }, { id: 'b02-1', start: 6, end: 12 }, { id: 'b03-1', start: 14, end: 20 }] };
  const after = { seconds: 17, lines: [{ id: 'b01-1', start: 0, end: 4 }, { id: 'b02-1', start: 5, end: 11 }, { id: 'b03-1', start: 12, end: 17 }] };
  const plan = { total_sec: 20, cues: [{ id: 'mc01', from_sec: 0, to_sec: 6, file: 'a.mp3', state: 'made' }, { id: 'mc02', from_sec: 6, to_sec: 14 }, { id: 'mc03', from_sec: 14, to_sec: 20 }] };
  const m = moveCues(plan, before, after);
  assert.equal(m.changed, true);
  assert.deepEqual(m.plan.cues.map((c) => [c.from_sec, c.to_sec]), [[0, 5], [5, 12], [12, 17]]);
  assert.equal(m.plan.cues[0].state, 'stale');
  assert.equal(m.plan.total_sec, 17);
  assert.equal(plan.cues[0].to_sec, 6, 'the plan read is not changed in place');
});

test('Speed stretches the whole voice (atempo) and scales the line and word times; 1x is untouched', async (t) => {
  const { root, work } = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { setVoiceSpeed, voiceLength } = await import('../src/svc/restitch.mjs');
  await restitchVoice({ root, id: ID });
  const t1 = JSON.parse(readFileSync(join(work, 'voice', 'timing.json'), 'utf8'));
  assert.equal(t1.speed, 1);
  assert.throws(() => setVoiceSpeed(work, 1.3), /speed is one of/);
  setVoiceSpeed(work, 1.1);
  assert.equal(voiceStale(work), true, 'a new speed makes the voice stale');
  const r = await restitchVoice({ root, id: ID });
  assert.equal(r.speed, 1.1);
  const t2 = JSON.parse(readFileSync(join(work, 'voice', 'timing.json'), 'utf8'));
  assert.ok(Math.abs(t2.seconds - t1.seconds / 1.1) < 0.02, `${t1.seconds} / 1.1 vs ${t2.seconds}`);
  assert.ok(Math.abs(wavSeconds(join(work, 'voice', 'voice.wav')) - t2.seconds) < 0.002);
  assert.ok(Math.abs(wavSeconds(join(work, 'sound', 'voice', 'voice.wav')) - t2.seconds) < 0.002, 'the soundtrack reads the stretched voice too');
  const k = t2.seconds / t1.seconds;
  assert.ok(Math.abs(t2.lines[2].start - t1.lines[2].start * k) < 0.002);
  assert.ok(Math.abs(t2.lines[2].words[0].end - t1.lines[2].words[0].end * k) < 0.002);
  assert.equal(voiceStale(work), false);
  const len = voiceLength(work, 1);
  assert.equal(len.speed, 1.1);
  assert.ok(len.over_sec > 0);
});
