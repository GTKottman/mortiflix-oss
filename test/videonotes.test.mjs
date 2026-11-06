// Video Notes: queue a scene on review, pick up the tablet's OK (notes -> one fix, none -> approve), reviewing imports
// nothing, status/setup are opt-in. A temp Video Notes root; no ffmpeg, no AI, no network, no port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { sceneGet, sceneBuilt, sceneRemaking, sendNotes, listNotes } from '../src/svc/lessons.mjs';
import { approveScene } from '../src/svc/stages.mjs';
import { okWords, queueScenes, pollTablet, closeOnApp, videoNotesStatus, videoNotesSetup, videoNotesLight, _test } from '../src/svc/videonotes.mjs';
import { setupStatusLight } from '../src/svc/setup.mjs';

const media = ({ dir }) => { writeFileSync(join(dir, 'video.mp4'), 'v'); writeFileSync(join(dir, 'poster.jpg'), 'p'); writeFileSync(join(dir, 'audio.wav'), 'a'); return { fps: 30, frames: 120, duration_s: 4 }; };

function setup(t, enabled = true) {
  const folder = mkdtempSync(join(tmpdir(), 'vn-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const root = tempStudio(t, { videoNotes: { enabled, folder } });
  const id = createProject(root, { pipeline: 'v3', title: 'The Long Explainer About Tides', answers: { topic: 'x' } }).id;
  const work = projectPaths(root, id).work;
  mkdirSync(join(work, 'script'), { recursive: true });
  const beats = ['b01', 'b02'].map((b, i) => ({ id: b, name: `Scene ${i + 1}`, visual: 'v', lines: [{ id: `${b}-1`, words: 'w' }] }));
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats }));
  mkdirSync(join(work, 'voice'), { recursive: true });
  writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify({ lines: [{ id: 'b01-1', text: 'Tides rise.', start: 0.5, end: 3 }, { id: 'b02-1', text: 'Tides fall.', start: 4.5, end: 7 }] }));
  mkdirSync(join(work, 'out', 'scenes'), { recursive: true });
  writeFileSync(join(work, 'out', 'scenes', 'b01.mp4'), 'clip');
  writeFileSync(join(work, 'out', 'scenes', 'clips.json'), JSON.stringify([{ beats: ['b01'], file: 'b01.mp4', from: 0, to: 120 }]));
  return { root, id, folder, work };
}
const tablet = (folder, vid, status, notes = []) => {
  mkdirSync(join(folder, vid, 'snaps'), { recursive: true });
  if (status) writeFileSync(join(folder, vid, 'status.json'), JSON.stringify({ status, at: 'x' }));
  for (const n of notes) if (n.snap) writeFileSync(join(folder, vid, n.snap), 'jpegbytes');
  writeFileSync(join(folder, vid, 'notes.json'), JSON.stringify(notes));
};
const bump = () => _test.sig.clear();
function actions(root, id, log) {
  return { ask: null, send: async (beat) => { log.push(['send', beat]); sendNotes(root, id, beat, { fix: () => { sceneRemaking(root, id, beat); return null; } }); }, approve: async (beat) => { log.push(['approve', beat]); approveScene(root, id, beat); } };
}

test('a scene whose tablet send failed says so (not sent, with the error), and a resend clears it', async (t) => {
  const { root, id } = setup(t);
  const { setSceneTablet } = await import('../src/svc/lessons.mjs');
  sceneBuilt(root, id, ['b01']);
  setSceneTablet(root, id, 'b01', { error: 'EACCES: the tablet folder cannot be written' });
  assert.deepEqual(sceneGet(root, id).scenes[0].tablet, { id: null, status: 'not sent', notes: 0, handled: false, error: 'EACCES: the tablet folder cannot be written' });
  const ids = await queueScenes(root, id, ['b01'], { media });
  assert.deepEqual(sceneGet(root, id).scenes[0].tablet, { id: ids[0], status: 'to review', notes: 0, handled: false, error: null });
});

test('review queues the scene in Video Notes, the same files as the MCP, and records the id', async (t) => {
  const { root, id, folder } = setup(t);
  sceneBuilt(root, id, ['b01']);
  const ids = await queueScenes(root, id, ['b01'], { media });
  assert.equal(ids.length, 1);
  const q = JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')).items;
  assert.equal(q[0].id, ids[0]);
  assert.equal(q[0].title, 'The Long Explainer About · Scene 1');
  assert.equal(q[0].project, 'The Long Explainer About Tides');
  assert.match(q[0].look_for, /^Scene 1 of 2, made with 0 lessons/);
  assert.equal(q[0].video, `${ids[0]}/video.mp4`);
  assert.deepEqual(q[0].ok_words, { notes: 'OK · Remake scene 1', none: 'OK · Next scene' }); // the tablet's OK says what it will do
  assert.deepEqual(JSON.parse(readFileSync(join(folder, ids[0], 'transcript.json'), 'utf8')), [{ f0: 15, f1: 90, text: 'Tides rise.' }]);
  const sc = sceneGet(root, id).scenes[0];
  assert.deepEqual(sc.tablet, { id: ids[0], status: 'to review', notes: 0, handled: false, error: null });
  assert.equal(sc.state, 'review');
});

test('off by default: nothing is queued', async (t) => {
  const { root, id, folder } = setup(t, false);
  sceneBuilt(root, id, ['b01']);
  assert.deepEqual(await queueScenes(root, id, ['b01'], { media }), []);
  assert.equal(existsSync(join(folder, 'queue.json')), false);
});

test('reviewing shows on the scene and imports nothing', async (t) => {
  const { root, id, folder } = setup(t);
  sceneBuilt(root, id, ['b01']);
  const [vid] = await queueScenes(root, id, ['b01'], { media });
  tablet(folder, vid, 'reviewing', [{ n: 1, id: 'a1', f: 30, text: 'too slow' }]);
  const log = [], ev = [];
  await pollTablet(root, id, { actions: actions(root, id, log), emit: (e) => ev.push(e) });
  assert.deepEqual(sceneGet(root, id).scenes[0].tablet, { id: vid, status: 'reviewing', notes: 1, handled: false, error: null });
  assert.equal(listNotes(root, id).notes.length, 0);
  assert.deepEqual(log, []);
  assert.deepEqual(ev, ['videonotes.changed']);
});

test('done with notes: imported once as pending notes, sent as ONE fix', async (t) => {
  const { root, id, folder } = setup(t);
  sceneBuilt(root, id, ['b01']);
  const [vid] = await queueScenes(root, id, ['b01'], { media });
  tablet(folder, vid, 'reviewing', [{ n: 1, id: 'a1', f: 30, text: 'too slow' }]);
  const log = [];
  await pollTablet(root, id, { actions: actions(root, id, log) });
  // the owner adds a second mark, then presses OK
  tablet(folder, vid, 'done', [{ n: 1, id: 'a1', f: 30, text: 'too slow', snap: 'snaps/a1.jpg' }, { n: 2, id: 'a2', f: 60, text: '', snap: 'snaps/a2.jpg' }]);
  bump();
  await pollTablet(root, id, { actions: actions(root, id, log) });
  assert.deepEqual(log, [['send', 'b01']]);
  const ns = listNotes(root, id, 'b01').notes;
  assert.equal(ns.length, 2);
  assert.ok(ns.every((n) => n.pending === false && n.sent_at), 'one fix sent them all');
  assert.equal(ns[0].time, 1);
  assert.match(ns[0].image, /\.jpg$/);
  assert.equal(readFileSync(ns[1].image, 'utf8'), 'jpegbytes');
  // polling again never imports twice
  bump();
  await pollTablet(root, id, { actions: actions(root, id, log) });
  assert.equal(listNotes(root, id).notes.length, 2);
  assert.equal(log.length, 1);
  assert.equal(sceneGet(root, id).scenes[0].tablet.handled, true);
  assert.equal(sceneGet(root, id).scenes[0].state, 'making', 'the CURRENT scene is remade, the next one is not started');
  assert.equal(sceneGet(root, id).current, 0);
  // the remade scene comes back to review and is queued again as a new version
  sceneBuilt(root, id, ['b01']);
  const [v2] = await queueScenes(root, id, ['b01'], { media });
  assert.notEqual(v2, vid);
  const q = JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')).items;
  assert.deepEqual(q.map((x) => x.id), [v2, vid]);
  assert.match(q[0].look_for, /fixed version/);
  assert.deepEqual(sceneGet(root, id).scenes[0].tablet, { id: v2, status: 'to review', notes: 0, handled: false, error: null });
  assert.equal(sceneGet(root, id).scenes[0].state, 'review');
});

test('done without notes approves the scene, which builds the next', async (t) => {
  const { root, id, folder } = setup(t);
  sceneBuilt(root, id, ['b01']);
  const [vid] = await queueScenes(root, id, ['b01'], { media });
  tablet(folder, vid, 'done', []);
  const log = [];
  await pollTablet(root, id, { actions: actions(root, id, log) });
  assert.deepEqual(log, [['approve', 'b01']]);
  const s = sceneGet(root, id);
  assert.deepEqual(s.scenes.map((x) => x.state), ['ok', 'making']);
  assert.equal(s.current, 1);
});

test('approving in the app first marks the tablet item done and stops watching it', async (t) => {
  const { root, id, folder } = setup(t);
  sceneBuilt(root, id, ['b01']);
  const [vid] = await queueScenes(root, id, ['b01'], { media });
  assert.equal(closeOnApp(root, id, 'b01'), true);
  assert.equal(JSON.parse(readFileSync(join(folder, vid, 'status.json'), 'utf8')).status, 'done');
  assert.equal(sceneGet(root, id).scenes[0].tablet.status, 'done'); // the scene record says done too, not a stale 'to review'
  assert.equal(closeOnApp(root, id, 'b01'), false);
  const log = [];
  await pollTablet(root, id, { actions: actions(root, id, log) });
  assert.deepEqual(log, []);
});

test('status and setup: opt-in, addresses without a new port, problems in plain words', async (t) => {
  const { root, folder } = setup(t, false);
  assert.deepEqual(setupStatusLight(root).videoNotes, { enabled: false, ready: false });
  const probe = {
    tailscale: async () => ({ status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'studio-pc.tail1.ts.net.' }, TailscaleIPs: ['100.64.0.5', 'fd7a::1'] }) }),
    interfaces: () => ({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], enp3: [{ family: 'IPv4', address: '192.168.1.20', internal: false }], tailscale0: [{ family: 'IPv4', address: '100.64.0.5', internal: false }] }),
    serve: async () => 'http://127.0.0.1:8686',
    ping: async (u) => u.includes('192.168') || u.includes('127.0.0.1:8686'),
  };
  const s = await videoNotesStatus(root, { probe });
  assert.equal(s.enabled, false);
  assert.equal(s.folder, folder);
  assert.deepEqual(s.addresses.map((a) => [a.kind, a.url]), [['tailscale', 'https://studio-pc.tail1.ts.net:8443'], ['local', 'http://192.168.1.20:8443']]);
  assert.ok(s.addresses.every((a) => a.reachable), 'tailnet door checked through tailscale serve');
  assert.equal(s.tablet_seen, null);
  const missing = await videoNotesStatus(root, { probe: { tailscale: async () => ({ status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }), interfaces: () => ({}), serve: async () => null, ping: async () => false } });
  assert.ok(missing.problems.some((p) => /Tailscale is not installed/.test(p)));
  assert.ok(missing.problems.some((p) => /No local network address/.test(p)));
  const on = videoNotesSetup(root, { enabled: true });
  assert.deepEqual([on.enabled, on.ready], [true, true]);
  assert.deepEqual(videoNotesLight(root), { enabled: true, ready: true });
  assert.equal(setupStatusLight(root).videoNotes.enabled, true);
  const other = join(folder, 'elsewhere');
  assert.equal(videoNotesSetup(root, { folder: other }).folder, other);
  assert.equal(videoNotesSetup(root, { enabled: false }).enabled, false);
  assert.equal(videoNotesStatus.length >= 1, true);
});

test('ok_words: every kind of item says what OK will do (notes / none); the last one says Done', () => {
  assert.deepEqual(okWords('scene', { n: 2, last: false }), { notes: 'OK · Remake scene 2', none: 'OK · Next scene' });
  assert.deepEqual(okWords('scene', { n: 5, last: true }), { notes: 'OK · Remake scene 5', none: 'OK · Done' });
  assert.deepEqual(okWords('frame'), { notes: 'OK · Remake this frame', none: 'OK · Next frame' });
  assert.deepEqual(okWords('frame', { group: true }), { notes: 'OK · Remake this frame', none: 'OK · Next group' });
  assert.deepEqual(okWords('still', { group: true }), { notes: 'OK · Remake this still', none: 'OK · Next group' });
  assert.deepEqual(okWords('video'), { notes: 'OK · Send my notes', none: 'OK' });
});

test('resend replaces the scene\'s open tablet item, refuses plainly when off or no clip', async (t) => {
  const { root, id, folder } = setup(t);
  const { resendScene } = await import('../src/svc/videonotes.mjs');
  sceneBuilt(root, id, ['b01']);
  const [first] = await queueScenes(root, id, ['b01'], { media });
  await assert.rejects(resendScene(root, id, 'b02', { media }), /no clip/);
  const r = await resendScene(root, id, 'b01', { media });
  const q = JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')).items;
  assert.equal(q.length, 1);
  assert.notEqual(q[0].id, first);
  assert.equal(r.tablet.id, q[0].id);
  assert.deepEqual(q[0].ok_words, { notes: 'OK · Remake scene 1', none: 'OK · Next scene' });
  // a done item is kept in the queue
  tablet(folder, q[0].id, 'done'); 
  const { setSceneTablet } = await import('../src/svc/lessons.mjs');
  setSceneTablet(root, id, 'b01', { handled: true, status: 'done' });
  await resendScene(root, id, 'b01', { media });
  assert.equal(JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')).items.length, 2);
  const off = setup(t, false);
  await assert.rejects(resendScene(off.root, off.id, 'b01', { media }), /Video Notes is off/);
});

test('eta_s: null until a scene was timed, then the median less time spent', (t) => {
  const { root, id } = setup(t);
  assert.equal(sceneGet(root, id).scenes[0].eta_s, null);
  assert.equal('eta_s' in sceneGet(root, id).scenes[1], false); // waiting
  sceneRemaking(root, id, 'b01'); // starts the clock
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  now += 100_000; sceneBuilt(root, id, ['b01']);
  sceneRemaking(root, id, 'b01');
  assert.equal(sceneGet(root, id).scenes[0].eta_s, 100);
  now += 30_000;
  assert.equal(sceneGet(root, id).scenes[0].eta_s, 70);
});
