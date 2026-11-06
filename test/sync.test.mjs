// Fix it (plan 30 + owner decisions 2026-11-01): sync.check / sync.fix / videonotes.reconcile / project.recheck.
// Free and local: a fake tool worker, a temp Video Notes folder, no Claude, no network, no paid call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createService, FAST } from '../src/service.mjs';
import { createProject, projectPaths, loadProject, update, readEvents } from '../src/projects.mjs';
import { sceneGet, sceneBuilt } from '../src/svc/lessons.mjs';
import { approveScene } from '../src/svc/stages.mjs';
import { queueScenes } from '../src/svc/videonotes.mjs';
import { chatHistory } from '../src/svc/chat.mjs';

const media = ({ dir }) => { writeFileSync(join(dir, 'video.mp4'), 'v'); writeFileSync(join(dir, 'poster.jpg'), 'p'); writeFileSync(join(dir, 'audio.wav'), 'a'); return { fps: 30, frames: 120, duration_s: 4 }; };

function rig(t, { loggedIn = false, ffmpeg = true, backend = 'demo' } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'vn-'));
  const wdir = mkdtempSync(join(tmpdir(), 'sw-'));
  t.after(() => { rmSync(folder, { recursive: true, force: true }); rmSync(wdir, { recursive: true, force: true }); });
  const worker = join(wdir, 'worker.mjs');
  const answer = { claude: { found: true, logged_in: loggedIn }, tools: { ffmpeg: { ok: ffmpeg } } };
  const setAnswer = (a) => writeFileSync(worker, `console.log(${JSON.stringify(JSON.stringify(a))});\n`);
  setAnswer(answer);
  const root = tempStudio(t, { backend, videoNotes: { enabled: true, folder } });
  const id = createProject(root, { pipeline: 'v3', title: 'Tides', answers: { topic: 'x' } }).id;
  const work = projectPaths(root, id).work;
  mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: ['b01', 'b02'].map((b, i) => ({ id: b, name: `Scene ${i + 1}`, visual: 'v', lines: [{ id: `${b}-1`, words: 'w' }] })) }));
  mkdirSync(join(work, 'voice'), { recursive: true });
  writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify({ lines: [{ id: 'b01-1', text: 'Tides rise.', start: 0.5, end: 3 }, { id: 'b02-1', text: 'Tides fall.', start: 4.5, end: 7 }] }));
  mkdirSync(join(work, 'out', 'scenes'), { recursive: true });
  writeFileSync(join(work, 'out', 'scenes', 'b01.mp4'), 'clip');
  writeFileSync(join(work, 'out', 'scenes', 'clips.json'), JSON.stringify([{ beats: ['b01'], file: 'b01.mp4', from: 0, to: 120 }]));
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0, setupWorker: worker });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const rid = n++;
    await svc.handle({ id: rid, type, params });
    const r = out.find((m) => m.id === rid);
    if (!r.ok) { const e = new Error(`${r.error.code}: ${r.error.message}`); e.code = r.error.code; throw e; }
    return r.result;
  };
  return { root, id, folder, call, out, setAnswer, svc };
}
const pause = (root, id, needs_you) => update(root, id, (p) => { p.state = 'paused'; p.needs_you = needs_you; });

test('sync.check is a FAST read and says nothing when all is well', async (t) => {
  assert.ok(FAST.has('sync.check'));
  const { call, setAnswer } = rig(t, { loggedIn: true });
  setAnswer({ claude: { found: true, logged_in: true }, tools: { ffmpeg: { ok: true } } });
  assert.deepEqual(await call('sync.check'), []);
});

test('case 3: the app wins. A scene settled in the app closes on the tablet; notes stay', async (t) => {
  const { root, id, folder, call, out } = rig(t);
  sceneBuilt(root, id, ['b01']);
  const [vid] = await queueScenes(root, id, ['b01'], { media });
  writeFileSync(join(folder, vid, 'notes.json'), JSON.stringify([{ n: 1, text: 'keep me' }]));
  assert.deepEqual(await call('sync.check', { project: id }), [], 'still in review: nothing to fix');
  approveScene(root, id, 'b01'); // settled in the app by a path that does not tell the tablet
  assert.equal(sceneGet(root, id).scenes[0].state, 'ok');
  const c = await call('sync.check', { project: id });
  assert.equal(c.length, 1);
  assert.equal(c[0].case, 'tablet');
  assert.deepEqual(c[0].fix, { type: 'sync.fix', params: { case: 'tablet', project: id } });
  const r = await call('sync.fix', { case: 'tablet', project: id });
  assert.equal(r.done, true);
  assert.match(r.text, /Closed 1 scene/);
  assert.equal(JSON.parse(readFileSync(join(folder, vid, 'status.json'), 'utf8')).status, 'done');
  assert.equal(JSON.parse(readFileSync(join(folder, vid, 'notes.json'), 'utf8'))[0].text, 'keep me');
  assert.deepEqual(await call('sync.check', { project: id }), []);
  assert.ok(readEvents(root, id).some((e) => e.event === 'SYNC_FIX'));
  assert.ok(chatHistory(root, id).messages?.some?.((m) => m.text.startsWith('Fix it:')) ?? JSON.stringify(chatHistory(root, id)).includes('Fix it: Closed 1'));
  assert.ok(out.some((m) => m.event === 'chat.message'));
  assert.deepEqual(await call('videonotes.reconcile', { project: id }), { closed: 0, scenes: [] });
});

test('case 4: stopped and rate-limit resume once clear; billing and gave-up never', async (t) => {
  const { root, id, call } = rig(t);
  pause(root, id, { text: 'stopped', at: new Date().toISOString(), cause: 'stopped' });
  assert.equal((await call('sync.check', { project: id }))[0].case, 'paused');
  const r = await call('sync.fix', { case: 'paused', project: id });
  assert.equal(r.done, true);
  assert.equal(loadProject(root, id).state, 'queued');
  assert.equal(loadProject(root, id).needs_you, null);

  pause(root, id, { text: 'slow down', at: new Date().toISOString(), cause: 'rate-limit' });
  assert.deepEqual(await call('sync.check', { project: id }), [], 'wait not over: no button');
  assert.equal((await call('project.recheck', { project: id })).resumed, false);
  pause(root, id, { text: 'slow down', at: new Date(Date.now() - 6 * 60_000).toISOString(), cause: 'rate-limit' });
  assert.equal((await call('project.recheck', { project: id })).resumed, true);

  for (const cause of ['billing', 'gave-up', 'needs-ai', 'gpu']) {
    pause(root, id, { text: cause, at: new Date(Date.now() - 3600_000).toISOString(), cause, takeover: true });
    assert.deepEqual(await call('sync.check', { project: id }), []);
    const x = await call('project.recheck', { project: id });
    assert.equal(x.resumed, false);
    assert.equal(loadProject(root, id).state, 'paused', cause);
  }
  pause(root, id, { text: 'mine', at: 'x', cause: 'stopped', by_you: true });
  assert.equal((await call('project.recheck', { project: id })).resumed, false);
});

test('case 4 login: re-tests with the free auth status, never the paid chat test', async (t) => {
  const { root, id, call, setAnswer } = rig(t, { loggedIn: false, backend: 'claude' });
  pause(root, id, { text: 'signed out', at: new Date().toISOString(), cause: 'login' });
  const a = await call('project.recheck', { project: id });
  assert.equal(a.resumed, false);
  assert.match(a.why, /still signed out/);
  setAnswer({ claude: { found: true, logged_in: true }, tools: { ffmpeg: { ok: true } } });
  const b = await call('project.recheck', { project: id });
  assert.equal(b.resumed, true);
  assert.equal(loadProject(root, id).state, 'queued');
});

test('case 2: shown only on error; Fix it only when the answer is stale', async (t) => {
  const { call } = rig(t, { loggedIn: false, backend: 'claude' });
  assert.deepEqual(await call('sync.check'), [], 'nothing cached yet: nothing shown');
  await call('setup.status'); // fills the cache: signed out
  const c = await call('sync.check');
  assert.equal(c[0].case, 'tools');
  assert.match(c[0].text, /signed out/);
  assert.equal(c[0].fix, null, 'fresh answer: the error is real, no button');
  const r = await call('sync.fix', { case: 'tools' });
  assert.match(r.text, /Still wrong/);
});

test('sync.fix takes only the remaining case names', async (t) => {
  const { call } = rig(t);
  for (const bad of ['models.free', 'gpu', 'tabs', 'renders', 'kinetograph', 'lost', undefined]) await assert.rejects(call('sync.fix', { case: bad }), (e) => e.code === 'bad_request');
  await assert.rejects(call('videonotes.reconcile', {}).then(() => { throw new Error('should have needed a project'); }), (e) => e.code !== undefined || /project/.test(e.message));
});
