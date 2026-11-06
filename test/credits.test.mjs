// opt/credits: voice take keys, cost first, judge, cross-project audio cache, music balance/rate. No network: fetch is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { saveConfig, writeSecret } from '../src/studio.mjs';
import { projectPaths } from '../src/projects.mjs';
import { recordLines, takeKey, planLines } from '../src/soundtrack/voice.mjs';
import { judge } from '../src/voice/judge.mjs';
import { makePlan, makeSounds, setCue, okCue, cutCue, sfxHandlers, soundPaths } from '../src/svc/sfx.mjs';
import { setElevenKey } from '../src/voice/index.mjs';
import { musicHandlers } from '../src/svc/elmusic.mjs';
import { voiceMakeEstimate, lineTakeEstimate } from '../src/svc/voicecost.mjs';
import { voicecastHandlers } from '../src/svc/voicecast.mjs';

class PE extends Error { constructor(code, message) { super(message); this.code = code; } }
const tone = (f, s) => { mkdirSync(join(f, '..'), { recursive: true }); spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${s}`, f]); };

// ---- C1 + C2: voice ----
function voiceFetch() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ audio_base64: Buffer.alloc(9600).toString('base64'), alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] } }) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('C1: only a changed line is recorded; changing it back is free (archived take)', async (t) => {
  const root = tempStudio(t); const work = projectPaths(root, 'voice-test').work; mkdirSync(work, { recursive: true });
  const f = voiceFetch(); t.after(f.restore);
  const base = { work, key: 'k', voiceId: 'vid', model: 'eleven_v4' };
  const lines = [{ id: 'a', text: 'First line.' }, { id: 'b', text: '[warm] Second line.' }];
  assert.equal((await recordLines({ ...base, lines })).recorded.length, 2);
  assert.equal(f.calls.length, 2);
  assert.equal((await recordLines({ ...base, lines })).recorded.length, 0); // nothing changed
  assert.equal(f.calls.length, 2);
  const changed = [lines[0], { id: 'b', text: '[tired] Second line.' }];
  assert.deepEqual((await recordLines({ ...base, lines: changed })).recorded, ['b']);
  assert.equal(f.calls.length, 3);
  const back = await recordLines({ ...base, lines });
  assert.deepEqual(back.restored, ['b']); assert.equal(f.calls.length, 3); // zero requests
  // a setting change re-keys every line; a per-line stability only its own
  assert.notEqual(takeKey(lines[0], { voiceId: 'vid' }), takeKey(lines[0], { voiceId: 'vid', similarity: 0.5 }));
  assert.notEqual(takeKey(lines[0], { voiceId: 'vid' }), takeKey({ ...lines[0], stability: 0.9 }, { voiceId: 'vid' }));
  assert.equal(planLines({ work, lines, voiceId: 'vid', model: 'eleven_v4', stability: 0.5, similarity: 0.75 }).need.length, 0);
  assert.equal(planLines({ work, lines, voiceId: 'vid', model: 'eleven_v4', stability: 0.5, similarity: 0.1 }).need.length, 2);
});

test('C2: confirm:false returns the estimate and makes no request', async (t) => {
  const root = tempStudio(t); const work = projectPaths(root, 'voice-test').work; mkdirSync(work, { recursive: true });
  const f = voiceFetch(); t.after(f.restore);
  const r = await recordLines({ work, key: 'k', voiceId: 'vid', lines: [{ id: 'a', text: 'Hello there.' }], confirm: false });
  assert.equal(r.needs_confirm, true); assert.equal(r.characters, 12); assert.equal(r.credits_estimate, 12);
  assert.equal(f.calls.length, 0);
});

test('C2: voice.make / take / line.set estimates; no money without confirm', (t) => {
  const root = tempStudio(t); saveConfig(root, { voice: { engine: 'elevenlabs', elevenlabs: { voice_id: 'vid' } } });
  const dir = join(projectPaths(root, 'voice-test').work, 'voice'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lines.json'), JSON.stringify([{ id: 'a', text: 'Hello there.' }, { id: 'b', text: 'Second.' }]));
  const e = voiceMakeEstimate(root, 'voice-test');
  assert.equal(e.needs_confirm, true); assert.equal(e.characters, 19); assert.deepEqual(e.lines, ['a', 'b']);
  assert.equal(lineTakeEstimate(root, 'voice-test', 'b').credits_estimate, 7);
  let edits = 0;
  const h = voicecastHandlers({ root, needProject: () => 'voice-test', retake: () => { edits++; return { id: 'e1' }; } });
  const gate = h['voice.line.set']({ line: 'a', tags: 'tired' });
  assert.equal(gate.needs_confirm, true); assert.equal(edits, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'lines.json'), 'utf8'))[0].text, 'Hello there.'); // untouched
  assert.equal(h['voice.line.set']({ line: 'a', tags: 'tired', confirm: true }).edit.id, 'e1');
  assert.equal(h['voice.line.set']({ line: 'b', gap_after: 1 }).edit, null); // a gap alone is free
});

// ---- C3: judge ----
test('C3: casing, punctuation, digits, symbols and split names pass without a retake', () => {
  const ok = (s, h) => assert.equal(judge(s, h).pass, true, `${s} | ${h}`);
  ok('The big one is called PHP2Shell.', 'the big one is called PHP 2 Shell');
  ok('It cost 29 dollars, up 50%.', 'It cost twenty-nine dollars up fifty percent');
  ok('In 2024 we saw 3,000 hits.', 'In twenty twenty four we saw three thousand hits');
  ok('Dogs & cats.', 'Dogs and cats');
  assert.equal(judge('The patch fixes the remote code flaw today.', 'The patch fixes it today').pass, false);
});

// ---- C4: sfx ----
function sfxFixture(t, name) {
  const root = tempStudio(t);
  const work = projectPaths(root, name).work;
  const src = join(work, 'video', 'src'); mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'actions.json'), JSON.stringify([{ shot: 'b01', at_sec: 1, what: 'callIt', sound: 'Whoosh across a desk', dur_sec: 0.6 }, { shot: 'b02', at_sec: 3, what: 'pop', sound: 'Bubble pop', dur_sec: 0.6 }]));
  tone(join(work, 'voice', 'voice.wav'), 6);
  setElevenKey(root, 'k');
  return { root, work };
}
test('C4: the same sound in two projects bills once (cache: hit); shot scope; labels; ready', async (t) => {
  const a = sfxFixture(t, 'proj-one'); const mp = join(a.root, 'x.mp3'); tone(mp, 1); const bytes = readFileSync(mp);
  let n = 0; const f = async () => { n++; return { ok: true, status: 200, arrayBuffer: async () => bytes }; };
  const lib = join(a.root, 'emptylib'); mkdirSync(lib); writeFileSync(join(lib, 'index.json'), '[]');
  const plan = makePlan(a.work, { library: lib });
  assert.equal(plan.cues[0].what, 'Call it'); // glued label fixed
  assert.equal(plan.ready, false);
  const r1 = await makeSounds(a.root, a.work, { shot: 'b01', confirm: true }, { fetchImpl: f }); // only that shot
  assert.equal(n, 1); assert.equal(r1.made.length, 1);
  assert.equal(plan.cues.length, 2);
  // second project, same studio, same prompt and length: free
  const b = { root: a.root, work: projectPaths(a.root, 'proj-two').work };
  mkdirSync(join(b.work, 'video', 'src'), { recursive: true }); mkdirSync(join(b.work, 'voice'), { recursive: true });
  writeFileSync(join(b.work, 'video', 'src', 'actions.json'), JSON.stringify([{ shot: 'b01', at_sec: 2, what: 'x', sound: 'Whoosh across a desk', dur_sec: 0.6 }]));
  makePlan(b.work, { library: lib });
  const est = await makeSounds(b.root, b.work, { all: true }, { fetchImpl: f }); // no confirm: hit applies, nothing to pay
  assert.equal(n, 1); assert.deepEqual(est.from_library, ['fx01']); assert.equal(est.credits, 0);
  assert.match(readFileSync(soundPaths(b.work).calls, 'utf8'), /"cache":"hit"/);
  // ready only when every cue is OK or cut
  const h = sfxHandlers({ root: b.root, needProject: () => 'proj-two', ProtocolError: PE });
  assert.equal((await h['sfx.plan']({})).ready, false);
  okCue(b.work, 'fx01');
  assert.equal((await h['sfx.plan']({})).ready, true);
  assert.equal(setCue && cutCue && true, true);
});

// ---- C4 + balance: music ----
test('C4: music library hit, balance + measured rate, remix never calls the API', async (t) => {
  const root = tempStudio(t); saveConfig(root, { voice: { engine: 'elevenlabs', elevenlabs: { music: true } } }); writeSecret(root, 'elevenlabs_api_key', 'k');
  const work = projectPaths(root, 'music-test2').work; mkdirSync(join(work, 'voice'), { recursive: true });
  const mp = join(work, 'fx.mp3'); tone(mp, 4); const bytes = readFileSync(mp);
  let left = 10000; const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/subscription')) return { ok: true, json: async () => ({ character_limit: 10000, character_count: 10000 - left }) };
    left -= 120; return { ok: true, status: 200, arrayBuffer: async () => bytes };
  };
  mkdirSync(join(work, 'music'), { recursive: true });
  writeFileSync(join(work, 'music', 'cues.json'), JSON.stringify({ total_sec: 8, cues: [{ id: 'mc01', from_sec: 0, to_sec: 4, prompt: 'warm pads' }, { id: 'mc02', from_sec: 4, to_sec: 8, prompt: 'warm pads' }] }));
  const h = musicHandlers({ root, ProtocolError: PE, needProject: () => 'music-test2', fetchFn });
  assert.equal((await h['music.plan.get']({})).credits_per_sec_measured, null);
  const r = await h['music.cue.make']({ cue: 'mc01', confirm: true });
  assert.equal(r.balance, 9880); assert.equal(r.credits_per_sec_measured, 30);
  assert.equal((await h['music.plan.get']({})).balance, 9880);
  const before = urls.length;
  const r2 = await h['music.cue.make']({ cue: 'mc02' }); // same prompt and length: library, no confirm needed
  assert.equal(r2.from_library, true); assert.equal(r2.credits_estimate, 0);
  assert.equal(urls.length, before); // no request at all
  h['music.cue.set']({ cue: 'mc01', energy: 0.8, duck_db: -12 }); // remix: no network
  assert.equal(urls.length, before);
});
