import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { loadConfig } from '../src/studio.mjs';
import { createProject, projectPaths, update, loadProject, readEvents } from '../src/projects.mjs';
import * as keys from '../src/keys.mjs';
import { publishPlan, publish, publishStatus, postizChannels, savePublish, publishConfig, utcDate, POSTIZ_DEFAULT } from '../src/publish.mjs';
import { run } from '../src/cli.mjs';

delete process.env.UPLOAD_POST_API_KEY;
delete process.env.UPLOAD_POST_API;
delete process.env.POSTIZ_API_KEY;

// A social short that went through every gate: its approved final sits in the record.
function delivered(root, answers = { message: 'Bikes are faster than you think', platform: 'TikTok / Reels / Shorts' }, service = 'uploadpost') {
  if (service && publishConfig(loadConfig(root)).service === 'none') savePublish(root, { service });
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
  assert.throws(() => publishPlan(root, 'x'), /isn't set up.*mortiflix setup publish/);
  savePublish(root, { service: 'uploadpost' });
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

// ---- your own Postiz ----

const CHANNELS = [
  { id: 'ch-tt', name: 'Fast Bikes TT', identifier: 'tiktok', disabled: false },
  { id: 'ch-ig', name: 'fastbikes', identifier: 'instagram-standalone', disabled: false },
  { id: 'ch-yt', name: 'Fast Bikes', identifier: 'youtube', disabled: false },
  { id: 'ch-old', name: 'Old YouTube', identifier: 'youtube', disabled: true },
  { id: 'ch-x', name: '@fastbikes', identifier: 'x', disabled: false },
];

// A fake Postiz: channels, uploads, posts and the post list.
function fakePostiz({ channels = CHANNELS, posts = [] } = {}) {
  return fakeApi((url, init) => {
    if (url.endsWith('/integrations')) return init.headers.Authorization === 'pz-secret' ? [200, channels] : [401, { message: 'Unauthorized' }];
    if (url.endsWith('/upload')) return [200, { id: 'media-1', path: 'http://localhost:4007/uploads/final.mp4' }];
    if (url.endsWith('/posts') && init.method === 'POST') return [200, JSON.parse(init.body).posts.map((x, i) => ({ postId: `post-${i + 1}`, integration: x.integration.id }))];
    if (url.includes('/posts?')) return [200, { posts }];
    return [404, {}];
  });
}

test('postiz: chosen in setup, its address checked, its key separate', async (t) => {
  const root = tempStudio(t);
  assert.equal(publishConfig(loadConfig(root)).service, 'none');
  assert.equal(publishConfig(loadConfig(root)).postiz.url, POSTIZ_DEFAULT);
  assert.throws(() => savePublish(root, { service: 'myspace' }), /uploadpost, postiz or none/);
  assert.throws(() => savePublish(root, { service: 'postiz', url: 'ftp://box' }), /http:\/\/ or https:\/\//);
  assert.throws(() => savePublish(root, { service: 'postiz', url: 'https://me:pw@postiz.example' }), /no login in the address/);
  assert.equal(savePublish(root, { service: 'postiz', url: 'https://postiz.example/api/' }).postiz.url, 'https://postiz.example/api');

  const ok = await keys.verifyKey(root, 'postiz', 'k', { fetch: async (url) => { assert.equal(url, 'https://postiz.example/api/public/v1/integrations'); return new Response(JSON.stringify(CHANNELS)); } });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /4 channels connected \(tiktok, instagram-standalone, youtube, x\)/);
  assert.equal((await keys.verifyKey(root, 'postiz', 'k', { fetch: async () => new Response('{}', { status: 401 }) })).ok, false);
  assert.deepEqual(keys.keysFor(root, { backend: 'claude-code', steps: [{ work: ['motion', 'audio'] }] }), []);
  assert.throws(() => keys.setSessionKey(root, 'POSTIZ_API_KEY', 'x'), /its own place/);

  // Without a terminal, the same choice.
  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { await run(['--studio', root, 'setup', 'publish', 'uploadpost', '--profile', 'studio']); } finally { console.log = log; }
  assert.match(out.join('\n'), /Publishing through Upload-Post/);
  assert.deepEqual(publishConfig(loadConfig(root)), { service: 'uploadpost', profile: 'studio', postiz: { url: 'https://postiz.example/api' } });
});

test('postiz: names the channels first, uploads the final, posts to each, and never twice by accident', async (t) => {
  const root = tempStudio(t);
  savePublish(root, { service: 'postiz' });
  const id = delivered(root);
  const plan = publishPlan(root, id, { description: 'Link in bio', at: '2026-10-20T18:00', timezone: 'Europe/Madrid' });
  assert.equal(plan.profile, null);
  assert.throws(() => publishPlan(root, id, { to: 'pinterest' }), /can't publish to pinterest through Postiz/);
  await assert.rejects(postizChannels(root, plan, { fetch: fakePostiz().fetch }), /needs your Postiz API key.*mortiflix keys set postiz/);

  keys.saveKey(root, 'postiz', 'pz-secret');
  const ready = await postizChannels(root, plan, { fetch: fakePostiz().fetch });
  // The disabled channel is left out; Instagram matches the standalone kind too.
  assert.deepEqual(ready.channels.map((c) => [c.platform, c.id]), [['tiktok', 'ch-tt'], ['instagram', 'ch-ig'], ['youtube', 'ch-yt']]);
  await assert.rejects(postizChannels(root, { ...plan, platforms: ['linkedin'] }, { fetch: fakePostiz().fetch }), /no linkedin channel connected in your Postiz/);

  const api = fakePostiz();
  const sent = await publish(root, ready, { fetch: api.fetch });
  const [up, post] = api.calls;
  assert.equal(up.url, 'http://localhost:4007/api/public/v1/upload');
  assert.equal(up.init.headers.Authorization, 'pz-secret');
  assert.equal(up.form.get('file').size, 2048);
  assert.equal(post.url, 'http://localhost:4007/api/public/v1/posts');
  const body = JSON.parse(post.init.body);
  assert.equal(body.type, 'schedule');
  assert.equal(body.date, '2026-10-20T16:00:00.000Z');   // 18:00 in Madrid (summer time)
  assert.deepEqual(body.posts.map((x) => x.settings.__type), ['tiktok', 'instagram-standalone', 'youtube']);
  assert.equal(body.posts[0].settings.content_posting_method, 'DIRECT_POST');
  assert.equal(body.posts[0].settings.privacy_level, 'PUBLIC_TO_EVERYONE');
  assert.deepEqual(body.posts[2].settings, { __type: 'youtube', title: 'Fast bikes', type: 'public' });
  assert.equal(body.posts[0].value[0].content, 'Fast bikes\n\nLink in bio');
  assert.equal(body.posts[2].value[0].content, 'Link in bio');
  assert.deepEqual(body.posts[1].value[0].image, [{ id: 'media-1', path: 'http://localhost:4007/uploads/final.mp4' }]);

  assert.deepEqual(sent.posts.map((x) => [x.id, x.platform]), [['post-1', 'tiktok'], ['post-2', 'instagram'], ['post-3', 'youtube']]);
  assert.equal(loadProject(root, id).published[0].service, 'postiz');
  assert.match(readEvents(root, id).at(-1).details, /via Postiz at 2026-10-20T18:00 Europe\/Madrid/);

  // Postiz has no idempotency key: the studio refuses the same post again, unless you ask for it.
  await assert.rejects(publish(root, ready, { fetch: api.fetch }), /already sent.*--again/);
  const again = publishPlan(root, id, { description: 'Link in bio', at: '2026-10-20T18:00', timezone: 'Europe/Madrid', again: true });
  assert.notEqual(again.key, plan.key);
  await publish(root, again, { fetch: fakePostiz().fetch });
  assert.equal(loadProject(root, id).published.length, 2);
});

test('postiz: a refused upload or post records nothing; status reads each post back with its link', async (t) => {
  const root = tempStudio(t);
  savePublish(root, { service: 'postiz' });
  const id = delivered(root);
  keys.saveKey(root, 'postiz', 'pz-secret');
  const plan = await postizChannels(root, publishPlan(root, id, { to: 'tiktok,youtube' }), { fetch: fakePostiz().fetch });
  // Fails at one endpoint; the upload before it works.
  const failing = (where, status) => fakeApi((url) => (url.endsWith(where) ? [status, { message: 'Bad video' }] : [200, { id: 'm', path: 'p' }]));
  await assert.rejects(publish(root, plan, { fetch: failing('/upload', 400).fetch }), /didn't take the video \(400\): Bad video\. Nothing was posted/);
  await assert.rejects(publish(root, plan, { fetch: failing('/posts', 400).fetch }), /didn't take the post \(400\): Bad video/);
  await assert.rejects(publish(root, plan, { fetch: async () => { throw new Error('ECONNREFUSED'); } }), /couldn't reach your Postiz at http:\/\/localhost:4007\/api/);
  assert.equal(loadProject(root, id).published, undefined);

  await publish(root, plan, { fetch: fakePostiz().fetch });
  const api = fakePostiz({ posts: [
    { id: 'post-1', state: 'PUBLISHED', releaseURL: 'https://www.tiktok.com/@me/video/1', integration: { providerIdentifier: 'tiktok' } },
    { id: 'post-2', state: 'ERROR', error: 'Daily upload limit reached', integration: { providerIdentifier: 'youtube' } },
    { id: 'someone-else', state: 'QUEUE' },
  ] });
  const st = await publishStatus(root, id, { fetch: api.fetch });
  assert.match(api.calls[0].url, /^http:\/\/localhost:4007\/api\/public\/v1\/posts\?startDate=.+&endDate=/);
  assert.equal(st.status, 'partly done');
  assert.deepEqual(st.results, [
    { platform: 'tiktok', state: 'completed', url: 'https://www.tiktok.com/@me/video/1', message: null },
    { platform: 'youtube', state: 'failed', url: null, message: 'Daily upload limit reached' },
  ]);
});

test('publish: a time without an offset is read in its time zone', () => {
  assert.equal(utcDate('2026-10-20T18:00'), '2026-10-20T18:00:00.000Z');
  assert.equal(utcDate('2026-10-20T18:00', 'Europe/Madrid'), '2026-10-20T16:00:00.000Z');
  assert.equal(utcDate('2026-12-20T18:00', 'Europe/Madrid'), '2026-12-20T17:00:00.000Z');
  assert.equal(utcDate('2026-12-20T18:00', 'America/Chicago'), '2026-12-21T00:00:00.000Z');
  assert.equal(utcDate('2026-10-20T18:00+02:00', 'America/Chicago'), '2026-10-20T16:00:00.000Z');
});
