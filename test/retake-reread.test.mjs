// A confirmed re-read records the changed lines (2026-11-02, director run, 5 lines): "Make 5 items" emptied the queue at
// once and made nothing. The New take route deleted the line's cached take, so makeVoice adopted the line's OLD clip
// (voice/clips/<id>.wav) as a take of the NEW words: no ElevenLabs call, the "words changed" flag cleared, the new
// words showed over the old audio. These tests stub fetch: no real paid call is ever made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, projectPaths } from '../src/projects.mjs';
import { nodeAction, loadEdits } from '../src/canvas.mjs';
import { routeOpenEdits } from '../src/svc/editroutes.mjs';
import { makeVoice } from '../src/soundtrack/voice.mjs';

const RATE = 48000;
const VOICE_ID = 'voice-test';

// 0.1 s silence, 0.5 s tone, 0.1 s silence: 16-bit pcm as ElevenLabs gives it
const tone = (f) => {
  const n = Math.round(0.7 * RATE); const b = Buffer.alloc(n * 2);
  for (let i = Math.round(0.1 * RATE); i < Math.round(0.6 * RATE); i++) b.writeInt16LE(Math.round(Math.sin(i / f) * 8000), i * 2);
  return b;
};
// ElevenLabs' character alignment for `text` spread over the tone
const alignment = (text) => {
  const ch = [...text]; const d = 0.5 / ch.length;
  return { characters: ch, character_start_times_seconds: ch.map((_, i) => 0.1 + i * d), character_end_times_seconds: ch.map((_, i) => 0.1 + (i + 1) * d) };
};

function fakeEleven(calls, { fail = false } = {}) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), text: body.text });
    if (fail) return { ok: false, status: 500, text: async () => 'down', headers: { get: () => null } };
    return { ok: true, status: 200, headers: { get: () => String(body.text.length) },
      json: async () => ({ audio_base64: tone(7 + calls.length).toString('base64'), alignment: alignment(body.text) }) };
  };
}

// A project whose two lines were recorded with their OLD words, joined once (voice/clips written by the voice step),
// then the script rewrote both lines (voice/lines.json has the new words): both need a re-read.
async function rewritten(t) {
  const root = tempStudio(t, { voice: { engine: 'elevenlabs', elevenlabs: { voice_id: VOICE_ID } } });
  writeFileSync(join(root, 'secrets.json'), JSON.stringify({ elevenlabs_api_key: 'test-key' }));
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x', length: '60 s' } });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  const old = [{ id: 'b01-1', text: 'The power cords, pulled out.' }, { id: 'b01-2', text: 'And its AI does not just read plates.' }];
  const cache = join(work, 'sound', 'voice', 'lines');
  mkdirSync(cache, { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true });
  for (const [i, l] of old.entries()) {
    writeFileSync(join(cache, `${l.id}.pcm`), tone(3 + i));
    writeFileSync(join(cache, `${l.id}.json`), JSON.stringify({ id: l.id, text: l.text, voice_id: VOICE_ID, model: 'eleven_v4', alignment: alignment(l.text) }));
  }
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify(old.map((l) => ({ ...l, script: l.text, gap_after: 0.3 }))));
  const first = await makeVoice({ work, key: null, confirm: false, voiceId: VOICE_ID });
  assert.ok(first.file && existsSync(join(work, 'voice', 'clips', 'b01-1.wav')));
  const now = [{ id: 'b01-1', text: 'The cords, pulled.' }, { id: 'b01-2', text: 'Its AI reads more than plates:' }];
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify(now.map((l) => ({ ...l, script: l.text, gap_after: 0.3 }))));
  return { root, id: p.id, work, cache, old, now };
}

const said = (cache, id) => JSON.parse(readFileSync(join(cache, `${id}.json`), 'utf8')).text;

test('a confirmed re-read calls ElevenLabs once per changed line, saves the takes and rebuilds the voice', async (t) => {
  const { root, id, work, cache, now } = await rewritten(t);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeEleven(calls);
  t.after(() => { globalThis.fetch = real; });
  const edits = now.map((l) => nodeAction(root, id, l.id, { action: 'fix', text: 'New take of this line (keep it inside its slot).' }).edit);
  const r = await routeOpenEdits({ root, id });
  assert.deepEqual(r.handled.sort(), edits.map((e) => e.id).sort());
  // one TTS call per changed line, each with that line's new words
  assert.deepEqual(calls.map((c) => c.text), now.map((l) => l.text));
  assert.ok(calls.every((c) => c.url.includes(`/text-to-speech/${VOICE_ID}/with-timestamps`)));
  for (const l of now) {
    assert.equal(said(cache, l.id), l.text, `${l.id}: the cache says the new words`);
    assert.ok(readdirSync(join(work, 'sound', 'voice', 'takes')).some((f) => f.startsWith(`${l.id}-`) && f.endsWith('.pcm')), `${l.id}: the take is archived`);
  }
  const timing = JSON.parse(readFileSync(join(work, 'voice', 'timing.json'), 'utf8'));
  assert.deepEqual(timing.lines.map((l) => l.text), now.map((l) => l.text));
  assert.ok(timing.lines.every((l) => l.words.length > 0), 'word timings come back with the new takes');
  assert.ok(existsSync(join(work, 'voice', 'voice.wav')));
  for (const e of edits) assert.equal(loadEdits(root, id).find((x) => x.id === e.id).state, 'done');
});

test('a re-read that ElevenLabs does not make clears no flag: the old take keeps its old words, the edit is not done', async (t) => {
  const { root, id, cache, old, now } = await rewritten(t);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeEleven(calls, { fail: true });
  t.after(() => { globalThis.fetch = real; });
  const e = nodeAction(root, id, now[0].id, { action: 'fix', text: 'New take of this line (keep it inside its slot).' }).edit;
  const r = await routeOpenEdits({ root, id });
  assert.equal(calls.length, 1, 'it really asked ElevenLabs');
  assert.deepEqual(r.failed, [e.id]);
  assert.deepEqual(r.left, [], 'never left to a Claude session');
  assert.equal(said(cache, now[0].id), old[0].text, 'the cache still says the old words: "words changed" stays');
  assert.equal(loadEdits(root, id).find((x) => x.id === e.id).state, 'failed');
});

test('a clip adopted with no record of its words never claims the line\'s new words', async (t) => {
  const { work, cache, now } = await rewritten(t);
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('ElevenLabs was called'); };
  t.after(() => { globalThis.fetch = real; });
  // the old bug's state: the cached take gone, the line's old clip left in voice/clips
  rmSync(join(cache, `${now[0].id}.json`)); rmSync(join(cache, `${now[0].id}.pcm`));
  await makeVoice({ work, key: null, confirm: false, voiceId: VOICE_ID });
  assert.notEqual(said(cache, now[0].id), now[0].text);
});

// Dir2 (2026-11-02): the queue sends its takes one by one; the route took the first two, the third (60 ms later) went
// to a Claude session that recorded the line twice with its own tools (an MP3 take too). Nothing may reach ElevenLabs
// before the owner's confirm, and after it each line gets exactly one call, all by the route.
test('the queue: zero calls before the confirm, then exactly one call per line, all routed (no session)', async (t) => {
  const { createService } = await import('../src/service.mjs');
  const { root, id, now } = await rewritten(t);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeEleven(calls);
  t.after(() => { globalThis.fetch = real; });
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const k = n++;
    await svc.handle({ id: k, type, params: { project: id, ...params } });
    const r = out.find((m) => m.id === k);
    if (!r.ok) throw new Error(`${type}: ${r.error.message}`);
    return r.result;
  };
  // pricing the queue (the app asks each line's cost): estimates only
  for (const l of now) {
    const e = await call('voice.line.take', { line: l.id });
    assert.equal(e.needs_confirm, true);
  }
  assert.equal(calls.length, 0, 'no ElevenLabs call before the confirm');
  assert.equal(loadEdits(root, id).length, 0, 'no edit before the confirm');
  // the confirm: the app sends the takes one by one; the route starts after the first and the second arrives meanwhile
  await call('voice.line.take', { line: now[0].id, confirm: true });
  const routing = routeOpenEdits({ root, id, settleMs: 300 });
  await new Promise((ok) => setTimeout(ok, 5));
  await call('voice.line.take', { line: now[1].id, confirm: true });
  const r = await routing;
  assert.equal(r.left.length, 0, 'nothing left for a session');
  assert.equal(r.handled.length, 2);
  assert.deepEqual(calls.map((c) => c.text).sort(), now.map((l) => l.text).sort(), 'one call per line');
  assert.ok(loadEdits(root, id).every((e) => e.state === 'done'));
});
