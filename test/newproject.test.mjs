import test from 'node:test';
import assert from 'node:assert/strict';
import { tempStudio } from './helpers.mjs';
import { voicesList } from '../src/svc/newproject.mjs';
import { listPresets } from '../src/svc/presets.mjs';
import { loadPipeline } from '../src/pipelines.mjs';
import { findPipeline } from '../src/pipelines.mjs';

test('voices.list: no key', async (t) => {
  const root = tempStudio(t);
  const old = process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_API_KEY;
  t.after(() => { if (old) process.env.ELEVENLABS_API_KEY = old; });
  assert.deepEqual(await voicesList(root, { fetch: () => assert.fail('no call') }), { voices: [], reason: 'no_key' });
});

test('voices.list: maps account voices (mocked fetch)', async (t) => {
  const root = tempStudio(t);
  process.env.ELEVENLABS_API_KEY = 'xi-test'; t.after(() => { delete process.env.ELEVENLABS_API_KEY; });
  const urls = [];
  const fetch = async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ has_more: false, total_count: 1, voices: [{ voice_id: 'v1', name: 'Tracy', category: 'premade', labels: { accent: 'neutral' }, preview_url: 'https://storage.googleapis.com/x.mp3', extra: 1 }] }) }; };
  const r = await voicesList(root, { fetch });
  assert.deepEqual(r.voices, [{ id: 'v1', name: 'Tracy', category: 'premade', labels: { accent: 'neutral' }, preview_url: 'https://storage.googleapis.com/x.mp3' }]);
  assert.match(urls[0], /\/v2\/voices/);
});

test('v3 preset is built in and valid', (t) => {
  const root = tempStudio(t);
  const v3 = listPresets(root).built_in.find((p) => p.slug === 'v3');
  assert.ok(v3 && !v3.error);
  assert.deepEqual(v3.steps.map((s) => s.key), ['brief', 'script', 'voice', 'style-frames', 'stills', 'animatic', 'sound', 'artcraft']);
  assert.equal(v3.length, null); // owner 2026-11-01: no default length, Claude picks the length the topic needs
  assert.ok(findPipeline(root, 'v3').steps.find((s) => s.key === 'artcraft').delivers);
});
