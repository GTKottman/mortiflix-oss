// A re-read batch (Dir3 61dc, 2026-11-02): 7 lines queued, one of them (b08-2) with no take yet. ElevenLabs was called
// 8 times: b08-2 was recorded inside b03-1's take (makeVoice recorded every line with no take) and again for its own.
// Each queued line is recorded exactly once; the voice is joined when every line has its take; the scene cuts
// (out/voice/bNN.wav) follow the new voice; the estimate prices characters at the rate ElevenLabs billed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, projectPaths } from '../src/projects.mjs';
import { nodeAction, loadEdits } from '../src/canvas.mjs';
import { routeOpenEdits } from '../src/svc/editroutes.mjs';
import { makeVoice } from '../src/soundtrack/voice.mjs';
import { lineTakeEstimate, creditRate, resetCreditRates } from '../src/svc/voicecost.mjs';

const RATE = 48000;
const VOICE_ID = 'voice-test';
const TAKE = 'New take of this line (keep it inside its slot).';

const tone = (f) => {
  const n = Math.round(0.7 * RATE); const b = Buffer.alloc(n * 2);
  for (let i = Math.round(0.1 * RATE); i < Math.round(0.6 * RATE); i++) b.writeInt16LE(Math.round(Math.sin(i / f) * 8000), i * 2);
  return b;
};
const alignment = (text) => {
  const ch = [...text]; const d = 0.5 / ch.length;
  return { characters: ch, character_start_times_seconds: ch.map((_, i) => 0.1 + i * d), character_end_times_seconds: ch.map((_, i) => 0.1 + (i + 1) * d) };
};
function fakeEleven(calls) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.text);
    return { ok: true, status: 200, headers: { get: () => String(Math.round(body.text.length * 0.44)) },
      json: async () => ({ audio_base64: tone(7 + calls.length).toString('base64'), alignment: alignment(body.text) }) };
  };
}
function stubFetch(t) {
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = fakeEleven(calls);
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

// Three lines in two scenes; b01-1 and b02-1 have takes and were joined (with scene cuts), b02-2 has none yet.
async function project(t) {
  const root = tempStudio(t, { voice: { engine: 'elevenlabs', elevenlabs: { voice_id: VOICE_ID, model_id: 'eleven_v4' } } });
  writeFileSync(join(root, 'secrets.json'), JSON.stringify({ elevenlabs_api_key: 'test-key' }));
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x', length: '60 s' } });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  const cache = join(work, 'sound', 'voice', 'lines');
  mkdirSync(cache, { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true }); mkdirSync(join(work, 'out', 'voice'), { recursive: true });
  const had = [{ id: 'b01-1', text: 'Ice is slippery.' }, { id: 'b02-1', text: 'Nobody knew why.' }];
  for (const [i, l] of had.entries()) {
    writeFileSync(join(cache, `${l.id}.pcm`), tone(3 + i));
    writeFileSync(join(cache, `${l.id}.json`), JSON.stringify({ id: l.id, text: l.text, voice_id: VOICE_ID, model: 'eleven_v4', alignment: alignment(l.text) }));
  }
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify(had.map((l) => ({ ...l, script: l.text, gap_after: 0.3 }))));
  const first = await makeVoice({ work, key: null, confirm: false, voiceId: VOICE_ID });
  writeFileSync(join(work, 'out', 'voice', 'narration.wav'), readFileSync(first.file));
  for (const b of ['b01', 'b02']) writeFileSync(join(work, 'out', 'voice', `${b}.wav`), 'old scene cut');
  const lines = [{ id: 'b01-1', text: 'Ice is slippery, they say.' }, { id: 'b02-1', text: 'Nobody knew why.' }, { id: 'b02-2', text: 'Until a water film was found.' }];
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify(lines.map((l) => ({ ...l, script: l.text, gap_after: 0.3 }))));
  return { root, id: p.id, work, cache, lines };
}

test('a line with no take queued as a re-read is recorded exactly once, even after another line\'s take', async (t) => {
  const { root, id, work, lines } = await project(t);
  const calls = stubFetch(t);
  nodeAction(root, id, 'b01-1', { action: 'fix', text: TAKE });
  nodeAction(root, id, 'b02-2', { action: 'fix', text: TAKE });
  const r = await routeOpenEdits({ root, id, settleMs: 0 });
  assert.equal(r.handled.length, 2); assert.deepEqual(r.failed, []);
  assert.deepEqual(calls, [lines[0].text, lines[2].text], 'one call per queued line, b02-2 only once');
  assert.ok(loadEdits(root, id).every((e) => e.state === 'done'));
  const timing = JSON.parse(readFileSync(join(work, 'voice', 'timing.json'), 'utf8'));
  assert.deepEqual(timing.lines.map((l) => l.id), ['b01-1', 'b02-1', 'b02-2'], 'joined once every line had its take');
  // the scene cuts were cut again from the new narration (ffmpeg writes real wavs over the old files)
  for (const b of ['b01', 'b02']) assert.notEqual(readFileSync(join(work, 'out', 'voice', `${b}.wav`), 'utf8').slice(0, 13), 'old scene cut', `${b}.wav recut`);
});

test('a New take never pays for another line with no take; the voice waits for it, the take is kept', async (t) => {
  const { root, id, work, cache, lines } = await project(t);
  const calls = stubFetch(t);
  const before = statSync(join(work, 'out', 'voice', 'narration.wav')).mtimeMs;
  const e = nodeAction(root, id, 'b01-1', { action: 'fix', text: TAKE }).edit;
  const r = await routeOpenEdits({ root, id, settleMs: 0 });
  assert.deepEqual(calls, [lines[0].text], 'b02-2 (no take, not queued) is not recorded');
  assert.equal(loadEdits(root, id).find((x) => x.id === e.id).state, 'done', 'the take was made');
  assert.deepEqual(r.failed, []);
  assert.equal(JSON.parse(readFileSync(join(cache, 'b01-1.json'), 'utf8')).text, lines[0].text);
  assert.ok(existsSync(join(work, 'voice', 'clips', 'b01-1.wav')), 'the line is heard on its own');
  assert.equal(statSync(join(work, 'out', 'voice', 'narration.wav')).mtimeMs, before, 'no half voice joined');
  assert.ok(!existsSync(join(cache, 'b02-2.pcm')));
});

test('two routes at once (the immediate one and the runner\'s) make each take once', async (t) => {
  const { root, id, lines } = await project(t);
  const calls = stubFetch(t);
  for (const l of lines) nodeAction(root, id, l.id, { action: 'fix', text: TAKE });
  const [a, b] = await Promise.all([routeOpenEdits({ root, id, settleMs: 0, only: ['retake', 'words'] }), routeOpenEdits({ root, id, settleMs: 0 })]);
  assert.equal(calls.length, 3, 'three lines, three calls');
  assert.deepEqual(calls.sort(), lines.map((l) => l.text).sort());
  assert.equal(a.handled.length + b.handled.length, 3);
});

test('the estimate prices characters at the rate ElevenLabs billed (not one credit each)', async (t) => {
  const { root, id, work } = await project(t);
  resetCreditRates();
  t.after(resetCreditRates);
  const text = 'x'.repeat(100);
  assert.equal(lineTakeEstimate(root, id, 'b01-1', text).credits_estimate, 100, 'no bills yet: the list price');
  mkdirSync(join(work, 'sound', 'voice'), { recursive: true });
  const rows = Array.from({ length: 5 }, (_, i) => ({ engine: 'elevenlabs', model: 'eleven_v4', line: `b0${i}-1`, characters: 60, credits: 26 }));
  writeFileSync(join(work, 'sound', 'voice', 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  resetCreditRates();
  assert.ok(Math.abs(creditRate(root, 'eleven_v4') - 26 / 60) < 1e-9);
  const e = lineTakeEstimate(root, id, 'b01-1', text);
  assert.equal(e.credits_estimate, 44);
  assert.match(e.message, /about 44 ElevenLabs credits/);
});
