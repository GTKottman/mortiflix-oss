// The script's words reach the voice (RUN-BUGS Dir3, 2026-11-02): scene Fixes rewrote script/beats.json (session
// EDIT_DONE, not script.edit), voice/lines.json kept the OLD words, Voice & music said "words match" and a re-read
// would have read the old words. svc/script.mjs syncVoiceWords: every read of the script or the voice brings
// lines.json to the script's words; the kept takes still say the old ones, so the lines are words_changed until
// re-read, and the re-read reads the NEW words. fetch is stubbed: no paid call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, projectPaths } from '../src/projects.mjs';
import { nodeAction } from '../src/canvas.mjs';
import { routeOpenEdits } from '../src/svc/editroutes.mjs';
import { makeVoice } from '../src/soundtrack/voice.mjs';
import { scriptView, syncVoiceWords } from '../src/svc/script.mjs';
import { voiceMusicView } from '../src/svc/graph.mjs';

const RATE = 48000;
const VOICE_ID = 'voice-test';
const tone = (f) => {
  const n = Math.round(0.7 * RATE); const b = Buffer.alloc(n * 2);
  for (let i = Math.round(0.1 * RATE); i < Math.round(0.6 * RATE); i++) b.writeInt16LE(Math.round(Math.sin(i / f) * 8000), i * 2);
  return b;
};
const alignment = (text) => {
  const ch = [...text]; const d = 0.5 / ch.length;
  return { characters: ch, character_start_times_seconds: ch.map((_, i) => 0.1 + i * d), character_end_times_seconds: ch.map((_, i) => 0.1 + (i + 1) * d) };
};

const OLD = [
  ['b01-1', 'Why is ice so slippery?'],
  ['b02-1', "Fair enough: Lord Kelvin's brother, James Thomson, proposed it nearly two centuries ago."],
  ['b03-1', "It's dipoles."],
  ['b03-2', "A water molecule's atoms share electrons unequally."],
  ['b04-1', "Even near absolute zero, a film still forms, but it's more viscous than honey. Skiing?"],
  ['b04-2', 'Practically impossible.'],
];
const BEATS = [
  { id: 'b01', words: 'Why is ice so slippery?' },
  { id: 'b02', words: "Lord Kelvin's brother proposed that, nearly two centuries ago." },
  { id: 'b03', words: "It's dipoles: water molecules have a partly positive and a partly negative end." },
  { id: 'b04', words: 'Near absolute zero, a film still forms, more viscous than honey. Skiing? Practically impossible.' },
];

async function fixed(t) {
  const root = tempStudio(t, { voice: { engine: 'elevenlabs', elevenlabs: { voice_id: VOICE_ID } } });
  writeFileSync(join(root, 'secrets.json'), JSON.stringify({ elevenlabs_api_key: 'test-key' }));
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x', length: '60 s' } });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  const cache = join(work, 'sound', 'voice', 'lines');
  mkdirSync(cache, { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true }); mkdirSync(join(work, 'script'), { recursive: true });
  OLD.forEach(([id, text], i) => {
    writeFileSync(join(cache, `${id}.pcm`), tone(3 + i));
    writeFileSync(join(cache, `${id}.json`), JSON.stringify({ id, text, voice_id: VOICE_ID, model: 'eleven_v4', alignment: alignment(text) }));
  });
  // the voice step: the beats as they were, the lines with their words, the voice joined
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ version: 1, beats: BEATS.map((b) => ({ ...b, words: OLD.filter(([id]) => id.startsWith(`${b.id}-`)).map((x) => x[1]).join(' ') })) }));
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify(OLD.map(([id, text]) => ({ id, text, script: text, gap_after: 0.3 }))));
  await makeVoice({ work, key: null, confirm: false, voiceId: VOICE_ID });
  // then scene Fixes rewrote the beats (no script.edit): newer than lines.json
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ version: 1, beats: BEATS }));
  const later = new Date(Date.now() + 5000);
  utimesSync(join(work, 'script', 'beats.json'), later, later);
  return { root, id: p.id, work };
}

const linesJson = (work) => Object.fromEntries(JSON.parse(readFileSync(join(work, 'voice', 'lines.json'), 'utf8')).map((l) => [l.id, l]));

test('a Fix that rewrote the script reaches voice/lines.json, and the old takes show words_changed', async (t) => {
  const { root, id, work } = await fixed(t);
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('ElevenLabs was called'); };
  t.after(() => { globalThis.fetch = real; });
  const vm = voiceMusicView(root, id);
  const l = linesJson(work);
  assert.equal(l['b02-1'].text, BEATS[1].words);
  assert.equal(l['b03-1'].text, BEATS[2].words);
  assert.equal(l['b03-2'], undefined, 'a sentence the script no longer has is not read');
  // a two-sentence line stays one line: "...honey. Skiing?" + "Practically impossible."
  assert.equal(l['b04-1'].text, 'Near absolute zero, a film still forms, more viscous than honey. Skiing?');
  assert.equal(l['b04-2'].text, 'Practically impossible.');
  assert.equal(l['b01-1'].text, 'Why is ice so slippery?');
  const flag = Object.fromEntries(vm.voice.map((v) => [v.node, v.words_changed]));
  assert.deepEqual([flag['b01-1'], flag['b02-1'], flag['b03-1'], flag['b04-1'], flag['b04-2']], [false, true, true, true, false]);
  const sv = Object.fromEntries(scriptView(root, id).beats.flatMap((b) => b.lines).map((x) => [x.id, x.words_changed]));
  assert.deepEqual([sv['b01-1'], sv['b02-1'], sv['b03-1'], sv['b04-1'], sv['b04-2']], [false, true, true, true, false]);
  // nothing new to sync: lines.json is left alone
  assert.deepEqual(syncVoiceWords(root, id), { changed: [], added: [], removed: [] });
});

test('the re-read of a Fix-changed line reads the NEW words', async (t) => {
  const { root, id, work } = await fixed(t);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.text);
    return { ok: true, status: 200, headers: { get: () => String(body.text.length) }, json: async () => ({ audio_base64: tone(9).toString('base64'), alignment: alignment(body.text) }) };
  };
  t.after(() => { globalThis.fetch = real; });
  // the owner never opened Voice & music: the re-read itself brings the words over first
  nodeAction(root, id, 'b02-1', { action: 'fix', text: 'New take of this line (keep it inside its slot).' });
  const r = await routeOpenEdits({ root, id });
  assert.equal(r.handled.length, 1);
  assert.deepEqual(calls, [BEATS[1].words]);
  const vm = voiceMusicView(root, id);
  assert.equal(vm.voice.find((v) => v.node === 'b02-1').words_changed, false);
  assert.equal(linesJson(work)['b02-1'].text, BEATS[1].words);
});
