// Narration: the ElevenLabs and ComfyUI clients, the local Qwen3-TTS runner, the settings rules, and vo.mjs end to end against fake APIs
// (loaded into its process with --import): no network, no key, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempStudio } from './helpers.mjs';
import { requestBody, voiceSettings, ElevenLabs } from '../src/voice/elevenlabs.mjs';
import { saveVoice, voiceConfig, sessionVoiceEnv, setElevenKey, voiceOverview, ENGINES, NO_KEY_MESSAGE } from '../src/voice/index.mjs';
import { saveConfig } from '../src/studio.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const VO = join(REPO, 'pipelines/_shared/skills/voiceover/vo.mjs');
const FAKE = join(REPO, 'test/fixtures/fake-voice-apis.mjs');

test('ElevenLabs requests carry only what the model takes', () => {
  const base = { voice_id: 'v', stability: 0.4, similarity_boost: 0.8, style: 0.3, speed: 1.1, use_speaker_boost: false };
  const v4 = requestBody({ ...base, model_id: 'eleven_v4' }, 'Hi', { previous_text: 'Before', next_text: 'After', seed: 7 });
  assert.deepEqual(v4.voice_settings, { stability: 0.4, similarity_boost: 0.8 });
  assert.equal(v4.model_id, 'eleven_v4');
  assert.equal(v4.previous_text, 'Before');
  assert.equal(v4.next_text, 'After');
  assert.equal(v4.seed, 7);
  const v2 = voiceSettings({ ...base, model_id: 'eleven_multilingual_v2' });
  assert.deepEqual(v2, { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: false, speed: 1.1 });
  const dict = requestBody({ ...base, model_id: 'eleven_v4', language_code: 'en', apply_text_normalization: 'on', pronunciation_dictionaries: [{ id: 'a', version_id: '1' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }, 'x');
  assert.equal(dict.pronunciation_dictionary_locators.length, 3);
  assert.deepEqual(dict.pronunciation_dictionary_locators[0], { pronunciation_dictionary_id: 'a', version_id: '1' });
  assert.equal(dict.language_code, 'en');
  assert.equal(dict.apply_text_normalization, 'on');
  assert.equal(requestBody({ model_id: 'eleven_v4' }, 'x').apply_text_normalization, undefined);
});

test('the ElevenLabs client reads the plan, ranks models and refuses bad keys clearly', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (init.headers['xi-api-key'] !== 'good') return new Response('{"detail":{"message":"Invalid API key"}}', { status: 401 });
    if (u.pathname === '/v1/user/subscription') return Response.json({ tier: 'free', character_count: 9000, character_limit: 10000, can_use_instant_voice_cloning: false });
    if (u.pathname === '/v1/models') return Response.json([
      { model_id: 'eleven_flash_v2_5', can_do_text_to_speech: true, languages: [{}, {}] },
      { model_id: 'eleven_multilingual_sts_v2', can_do_text_to_speech: false },
      { model_id: 'eleven_v4', name: 'Eleven v4', can_do_text_to_speech: true, can_use_style: true, maximum_text_length_per_request: 10000, languages: Array(90).fill({}) },
    ]);
    if (u.pathname === '/v2/voices') return Response.json({ voices: [{ voice_id: 'x1', name: 'Ada', category: 'premade', labels: { accent: 'british' }, preview_url: 'https://storage.googleapis.com/p.mp3' }], has_more: false, total_count: 1 });
    if (u.pathname.startsWith('/v1/voices/add/')) return Response.json({ voice_id: 'copied' });
    return new Response('', { status: 404 });
  };
  const el = new ElevenLabs({ key: 'good', server: 'eu', fetch });
  const a = await el.account();
  assert.equal(a.characters_left, 1000);
  assert.equal(a.commercial_use, false);
  assert.equal(a.concurrency, 2);
  const models = await el.models();
  assert.deepEqual(models.map((m) => m.id), ['eleven_v4', 'eleven_flash_v2_5']);
  assert.equal(models[0].can_use_style, false); // v4 has no style setting, whatever the flag says
  assert.equal((await el.voices({ search: 'ada' })).voices[0].labels.accent, 'british');
  assert.equal((await el.addFromLibrary('owner1', 'lib1', 'Ada')).id, 'copied');
  assert.ok(calls.every((c) => c.startsWith('https://api.eu.residency.elevenlabs.io/')));
  await assert.rejects(new ElevenLabs({ key: 'bad', fetch }).account(), /401: Invalid API key/);
});

test('voice settings: ranges enforced, the key reaches sessions only for ElevenLabs', (t) => {
  const root = tempStudio(t);
  saveVoice(root, { engine: 'elevenlabs', elevenlabs: { stability: 7, speed: 3, output_format: 'nope', apply_text_normalization: 'on', unknown: 1 } });
  const v = voiceConfig(root);
  assert.equal(v.elevenlabs.stability, 1);
  assert.equal(v.elevenlabs.speed, 1.2);
  assert.equal(v.elevenlabs.output_format, 'mp3_44100_128');
  assert.equal(v.elevenlabs.unknown, undefined);
  assert.throws(() => saveVoice(root, { engine: 'robot' }), /engine/);
  setElevenKey(root, 'secret-key');
  assert.equal(sessionVoiceEnv(root).ELEVENLABS_API_KEY, 'secret-key');
  assert.ok(!sessionVoiceEnv(root).MFX_VOICE.includes('secret-key'));
  saveVoice(root, { engine: 'own' });
  assert.equal(sessionVoiceEnv(root).ELEVENLABS_API_KEY, undefined);
});

test('ElevenLabs is the default and the only generated voice: no local engine, an old local setting reads as ElevenLabs', (t) => {
  const root = tempStudio(t);
  assert.deepEqual(ENGINES, ['none', 'elevenlabs', 'own']);
  assert.equal(voiceConfig(root).engine, 'elevenlabs');
  assert.throws(() => saveVoice(root, { engine: 'qwen' }), /engine must be one of none, elevenlabs, own/);
  saveConfig(root, { voice: { engine: 'qwen', qwen: { voice: 'Ryan' } } });
  const v = voiceConfig(root);
  assert.equal(v.engine, 'elevenlabs');
  assert.equal(v.qwen, undefined);
  assert.ok(!JSON.parse(sessionVoiceEnv(root).MFX_VOICE).qwen, 'sessions never get local voice settings');
});

test('no ElevenLabs key: a plain message for Settings and the Voice stage, never a silent local fallback', (t) => {
  const root = tempStudio(t);
  const was = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => { if (was !== undefined) process.env.ELEVENLABS_API_KEY = was; });
  const o = voiceOverview(root);
  assert.equal(o.engine, 'elevenlabs');
  assert.equal(o.elevenlabs_key, null);
  assert.equal(o.needs_key, NO_KEY_MESSAGE);
  assert.match(o.needs_key, /no ElevenLabs API key is saved/);
  assert.equal(o.gpus, undefined);
  assert.equal(o.local, undefined);
  setElevenKey(root, 'k');
  assert.equal(voiceOverview(root).needs_key, null);
  saveVoice(root, { engine: 'none' });
  setElevenKey(root, null);
  assert.equal(voiceOverview(root).needs_key, null, 'no narration needs no key');
});

function voFixture(t) {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { t.skip('no ffmpeg'); return null; }
  const dir = mkdtempSync(join(tmpdir(), 'mfx-vo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.2', join(dir, 'tone.wav')]);
  writeFileSync(join(dir, 'lines.json'), JSON.stringify([
    { id: 'b01-1', text: '[warm] Every city has a heartbeat.', script: 'Every city has a heartbeat.', gap_after: 0.5 },
    { id: 'b01-2', text: 'Ours runs on bikes, all night long.' },
  ]));
  const run = (args, voice) => spawnSync('node', ['--import', FAKE, VO, ...args], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, MFX_HOME: REPO, MFX_VOICE: JSON.stringify(voice), ELEVENLABS_API_KEY: 'k', FAKE_WAV: join(dir, 'tone.wav'), FAKE_LOG: join(dir, 'log.jsonl') },
  });
  const log = () => readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, run, log };
}

test('vo.mjs with ElevenLabs: speaks with context, checks every take, retakes a bad one, builds the timing', (t) => {
  const f = voFixture(t);
  if (!f) return;
  const voice = { engine: 'elevenlabs', elevenlabs: { voice_id: 'voice1', voice_name: 'Ada', model_id: 'eleven_v4', output_format: 'wav_24000', stability: 0.5, similarity_boost: 0.75, style: 0.9 } };
  const r = f.run(['speak', 'lines.json', '--jobs', '1'], voice);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /b01-2 take 1: .*words in a row missing/);
  assert.match(r.stdout, /2\/2 lines passed/);
  const calls = f.log();
  const tts = calls.filter((c) => c.api === 'tts');
  assert.equal(tts.length, 3);
  assert.equal(tts[0].format, 'wav_24000');
  assert.deepEqual(Object.keys(tts[0].body.voice_settings), ['stability', 'similarity_boost']); // v4: no style
  assert.equal(tts[0].body.next_text, 'Ours runs on bikes, all night long.');
  assert.equal(tts[1].body.previous_text, '[warm] Every city has a heartbeat.');
  assert.notEqual(tts[1].body.seed, tts[2].body.seed);
  const stt = calls.filter((c) => c.api === 'stt');
  assert.equal(stt[0].model, 'scribe_v2');
  assert.deepEqual(stt[0].keyterms, ['Every']);
  const clip = JSON.parse(readFileSync(join(f.dir, 'voice/clips/b01-2.json'), 'utf8'));
  assert.equal(clip.take, 2);
  assert.equal(clip.pass, true);

  const b = f.run(['build', 'lines.json'], voice);
  assert.equal(b.status, 0, b.stderr);
  const timing = JSON.parse(readFileSync(join(f.dir, 'voice/timing.json'), 'utf8'));
  assert.equal(timing.lines.length, 2);
  assert.equal(timing.lines[0].timing, 'words');
  assert.equal(timing.lines[1].start, 1.7); // 1.2 s clip + 0.5 s gap
  assert.ok(existsSync(join(f.dir, 'voice/voice.wav')));
});

test('vo.mjs refuses the removed local voice in plain words', (t) => {
  const f = voFixture(t);
  if (!f) return;
  const r = f.run(['speak', 'lines.json'], { engine: 'qwen' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the local voice \(Qwen3-TTS\) was removed/);
});
