import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { loadConfig } from '../src/studio.mjs';
import { createProject, projectPaths, update, loadProject, readEvents } from '../src/projects.mjs';
import * as keys from '../src/keys.mjs';
import { publishPlan, publish, publishStatus } from '../src/publish.mjs';

delete process.env.UPLOAD_POST_API_KEY;
delete process.env.UPLOAD_POST_API;

// A social short that went through every gate: its approved final sits in the record.
function delivered(root, answers = { message: 'Bikes are faster than you think', platform: 'TikTok / Reels / Shorts' }) {
  const p = createProject(root, { pipeline: 'social-short', title: 'Fast bikes', answers });
  const file = 'reviews/final/v2/files/final.mp4';
  mkdirSync(join(projectPaths(root, p.id).state, 'reviews/final/v2/files'), { recursive: true });
  writeFileSync(join(projectPaths(root, p.id).state, file), Buffer.alloc(2048));
  update(root, p.id, (x) => { x.state = 'delivered'; x.deliverables = [{ label: 'Final', kind: 'video', file, size: 2048 }]; });
  return p.id;
}

// A fake Upload-Post that records what it was sent.
function fakeApi(reply) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, form: init.body instanceof FormData ? init.body : null });
    const [status, body] = reply(url, init);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetch };
}

test('publish: only a delivered video, to where the brief said, after the owner names a profile', (t) => {
  const root = tempStudio(t);
  const draft = createProject(root, { pipeline: 'social-short', title: 'Not yet', answers: { message: 'x' } });
  assert.throws(() => publishPlan(root, draft.id, { profile: 'me' }), /isn't delivered yet \(draft\)/);

  const id = delivered(root);
  assert.throws(() => publishPlan(root, id), /which Upload-Post profile/);
  const plan = publishPlan(root, id, { profile: 'me' });
  assert.deepEqual(plan.platforms, ['tiktok', 'instagram', 'youtube']);
  assert.equal(plan.from_brief, true);
  assert.equal(plan.title, 'Fast bikes');
  assert.equal(plan.size, 2048);
  assert.deepEqual(publishPlan(root, id, { profile: 'me', to: 'LinkedIn, x' }).platforms, ['linkedin', 'x']);
  assert.throws(() => publishPlan(root, id, { profile: 'me', to: 'myspace' }), /can't publish to myspace/);
  assert.throws(() => publishPlan(root, id, { profile: 'me', timezone: 'Europe/Madrid' }), /only goes with --at/);
  assert.throws(() => publishPlan(root, id, { profile: 'me', at: 'next tuesday' }), /isn't a date/);
  // "Anywhere" names no platform: the owner says where.
  const anywhere = delivered(root, { message: 'x', platform: 'Anywhere' });
  assert.throws(() => publishPlan(root, anywhere, { profile: 'me' }), /where to\?/);
  // The same post twice has the same key; a different time is a different post.
  assert.equal(publishPlan(root, id, { profile: 'me' }).key, plan.key);
  assert.notEqual(publishPlan(root, id, { profile: 'me', at: '2026-10-20T18:00' }).key, plan.key);
});

test('publish: sends the approved file with the key, records it, and remembers the profile', async (t) => {
  const root = tempStudio(t);
  const id = delivered(root);
  const plan = publishPlan(root, id, { profile: 'studio', description: 'Link in bio', at: '2026-10-20T18:00', timezone: 'Europe/Madrid' });
  await assert.rejects(publish(root, plan, { fetch: fakeApi(() => [200, {}]).fetch }), /needs your Upload-Post API key.*mortiflix keys set uploadpost/);

  keys.saveKey(root, 'uploadpost', 'up-secret');
  const api = fakeApi(() => [200, { success: true, job_id: 'job-1' }]);
  const sent = await publish(root, plan, { fetch: api.fetch });
  assert.equal(sent.job_id, 'job-1');
  const [call] = api.calls;
  assert.equal(call.url, 'https://api.upload-post.com/api/upload');
  assert.equal(call.init.headers.Authorization, 'Apikey up-secret');
  assert.equal(call.init.headers['Idempotency-Key'], plan.key);
  assert.equal(call.form.get('user'), 'studio');
  assert.deepEqual(call.form.getAll('platform[]'), ['tiktok', 'instagram', 'youtube']);
  assert.equal(call.form.get('title'), 'Fast bikes');
  assert.equal(call.form.get('description'), 'Link in bio');
  assert.equal(call.form.get('scheduled_date'), '2026-10-20T18:00');
  assert.equal(call.form.get('timezone'), 'Europe/Madrid');
  assert.equal(call.form.get('video').size, 2048);

  assert.equal(loadProject(root, id).published[0].job_id, 'job-1');
  assert.equal(readEvents(root, id).at(-1).event, 'PUBLISHED');
  assert.equal(loadConfig(root).publish.profile, 'studio');
  assert.equal(publishPlan(root, id).profile, 'studio');
});

test('publish: a refused key and a refused post are sentences, and nothing is recorded', async (t) => {
  const root = tempStudio(t);
  const id = delivered(root);
  keys.saveKey(root, 'uploadpost', 'up-secret');
  const plan = publishPlan(root, id, { profile: 'me' });
  await assert.rejects(publish(root, plan, { fetch: fakeApi(() => [401, { message: 'Invalid' }]).fetch }), /refused the API key/);
  await assert.rejects(publish(root, plan, { fetch: fakeApi(() => [400, { message: 'No TikTok account connected' }]).fetch }), /didn't take it \(400\): No TikTok account connected/);
  await assert.rejects(publish(root, plan, { fetch: async () => { throw new Error('offline'); } }), /couldn't reach Upload-Post.*never sent twice/);
  assert.equal(loadProject(root, id).published, undefined);
});

test('publish: status asks about the last post and reads back each platform', async (t) => {
  const root = tempStudio(t);
  const id = delivered(root);
  keys.saveKey(root, 'uploadpost', 'up-secret');
  await assert.rejects(publishStatus(root, id), /hasn't been published/);
  await publish(root, publishPlan(root, id, { profile: 'me', to: 'tiktok,youtube' }), { fetch: fakeApi(() => [200, { request_id: 'req-1' }]).fetch });
  const api = fakeApi(() => [200, { status: 'completed', results: [
    { platform: 'tiktok', status: 'completed', success: true, post_url: 'https://www.tiktok.com/@me/video/1' },
    { platform: 'youtube', status: 'failed', success: false, error_message: 'Daily upload limit reached' },
    { platform: 'x', status: 'queued', success: false },
  ] }]);
  const st = await publishStatus(root, id, { fetch: api.fetch });
  assert.equal(api.calls[0].url, 'https://api.upload-post.com/api/uploadposts/status?request_id=req-1');
  assert.equal(st.status, 'completed');
  assert.deepEqual(st.results, [
    { platform: 'tiktok', state: 'completed', url: 'https://www.tiktok.com/@me/video/1', message: null },
    { platform: 'youtube', state: 'failed', url: null, message: 'Daily upload limit reached' },
    // Not sent yet is not a failure.
    { platform: 'x', state: 'queued', url: null, message: null },
  ]);
});

test('keys: the Upload-Post key is checked with a free call and never handed to sessions', async (t) => {
  const root = tempStudio(t);
  const reply = (status, body = {}) => async () => new Response(JSON.stringify(body), { status });
  const ok = await keys.verifyKey(root, 'uploadpost', 'k', { fetch: reply(200, { success: true, plan: 'Basic' }) });
  assert.deepEqual(ok, { ok: true, detail: 'Basic plan' });
  assert.equal((await keys.verifyKey(root, 'uploadpost', 'k', { fetch: reply(401) })).ok, false);
  assert.equal((await keys.verifyKey(root, 'uploadpost', 'k', { fetch: reply(503) })).ok, null);
  keys.saveKey(root, 'uploadpost', 'up-secret');
  assert.equal(keys.keySource(root, 'uploadpost'), 'saved');
  assert.ok(!JSON.stringify(keys.keyStatus(root)).includes('up-secret'));
  assert.deepEqual(keys.keysFor(root, { backend: 'claude-code', steps: [{ work: ['motion', 'audio'] }] }), []);
  assert.throws(() => keys.setSessionKey(root, 'UPLOAD_POST_API_KEY', 'x'), /its own place/);
});
