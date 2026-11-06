// Style frames v3, version 10: Video Notes image items (service side) and the generalized pollTablet. A temp Video Notes root; no ffmpeg,
// no AI, no network, no port. (Never the owner's real Video Notes folder.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempStudio } from './helpers.mjs';
import { harness } from './sf-helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { queueImage, queueFrames, pollTablet, closeOnApp, tabletEntries, okWords, _test } from '../src/svc/videonotes.mjs';
import { saveFrames, loadFrames, planFrames, framesView } from '../src/svc/frames.mjs';
import { listNotes } from '../src/svc/lessons.mjs';
import { encodePng } from '../src/svc/png.mjs';

const media = ({ dir, image }) => { writeFileSync(join(dir, 'video.mp4'), 'v'); writeFileSync(join(dir, 'poster.jpg'), 'p'); writeFileSync(join(dir, 'audio.wav'), 'a'); if (image) writeFileSync(join(dir, 'image.png'), 'png'); return { w: 1920, h: 1080, fps: 30, frames: 30, duration_s: 1 }; };

function setup(t) {
  const folder = mkdtempSync(join(tmpdir(), 'vnimg-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const root = tempStudio(t, { videoNotes: { enabled: true, folder } });
  const p = createProject(root, { pipeline: 'v3', title: 'Black October Is Here Today', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  // three made frames waiting for the owner, 4 planned in all
  const st = { version: 1, planned: true, enough: false, rounds: [], frames: planFrames([1, 2, 3, 4].map((n) => ({ id: `b0${n}`, name: `Part ${n}`, from_sec: n * 10, to_sec: n * 10 + 10 }))) };
  for (const f of st.frames.slice(0, 3)) { f.state = 'review'; f.current = 1; f.note = `what ${f.id} shows`; f.versions = [{ v: 1, file: `out/frames/${f.id}-v1.png`, notes: 0 }]; mkdirSync(join(work, 'out', 'frames'), { recursive: true }); writeFileSync(join(work, 'out', 'frames', `${f.id}-v1.png`), encodePng(2, 2, new Uint8Array(16))); }
  saveFrames(work, st);
  return { root, id: p.id, work, folder };
}
const tablet = (folder, vid, status, notes = []) => {
  mkdirSync(join(folder, vid, 'snaps'), { recursive: true });
  if (status) writeFileSync(join(folder, vid, 'status.json'), JSON.stringify({ status, at: 'x' }));
  for (const n of notes) if (n.snap) writeFileSync(join(folder, vid, n.snap), 'jpegbytes');
  writeFileSync(join(folder, vid, 'notes.json'), JSON.stringify(notes));
};
const bump = () => _test.sig.clear();
const queue = (folder) => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')).items;

test('queueImage: the item has the image fields, ok_words, the group and the 1-second compatibility video; an older reader still finds video, poster, audio', async (t) => {
  const { root, id, folder, work } = setup(t);
  const vid = await queueImage(root, id, { kind: 'frame', ref: 'sf01', file: join(work, 'out/frames/sf01-v1.png'), title: 'Black October · Frame 1', look_for: 'Frame 1 of 4.', group: 'Black October · Look', group_index: 1, group_count: 4, ok_words: okWords('frame') }, { media });
  const it = queue(folder)[0];
  assert.equal(it.id, vid); assert.equal(it.kind, 'image'); assert.equal(it.image, `${vid}/image.png`); assert.equal(it.w, 1920);
  assert.deepEqual([it.group, it.group_index, it.group_count], ['Black October · Look', 1, 4]);
  assert.deepEqual(it.ok_words, { notes: 'OK · Remake this frame', none: 'OK · Next frame' });
  assert.equal(it.video, `${vid}/video.mp4`); assert.equal(it.audio, `${vid}/audio.wav`); assert.equal(it.duration_s, 1); assert.equal(it.fps, 30);
  assert.ok(existsSync(join(folder, vid, 'image.png')));
  assert.deepEqual(tabletEntries(root, id).map((e) => [e.key, e.t.status, e.t.handled]), [['frame:sf01', 'to review', false]]);
  // a missing picture is noted on the entry, never thrown
  assert.equal(await queueImage(root, id, { kind: 'frame', ref: 'sf09', file: join(work, 'nope.png'), title: 'x' }, { media }), null);
  assert.match(tabletEntries(root, id).find((e) => e.ref === 'sf09').t.error, /no picture/);
  // Video Notes off: nothing
  const off = tempStudio(t);
  assert.equal(await queueImage(off, id, { kind: 'frame', ref: 'sf01', file: 'x' }), null);
});

test('queueFrames: one item per made frame, grouped "Frame N of M", Next round on the last of a round, and the fixed version says so', async (t) => {
  const { root, id, folder, work } = setup(t);
  const made = await queueFrames(root, id, ['sf01', 'sf02', 'sf03', 'sf04'], { media }); // sf04 is not made: skipped
  assert.equal(made.length, 3);
  const items = queue(folder).reverse();
  assert.deepEqual(items.map((i) => i.title), ['Black October Is Here Today · Frame 1', 'Black October Is Here Today · Frame 2', 'Black October Is Here Today · Frame 3']);
  assert.match(items[0].look_for, /^Frame 1 of 4: what sf01 shows\. Made with 0 lessons/);
  assert.deepEqual(items.map((i) => i.group_index), [1, 2, 3]); assert.equal(items[0].group_count, 4);
  assert.deepEqual(items[2].ok_words, { notes: 'OK · Remake this frame', none: 'OK · Next frame' });
  // asked again for the same frame (remade): a new item, "This is the fixed version."
  await queueFrames(root, id, ['sf02'], { media });
  const again = queue(folder)[0];
  assert.match(again.look_for, /This is the fixed version\.$/);
  assert.equal(tabletEntries(root, id).find((e) => e.key === 'frame:sf02').t.prev.length, 1);
});

test('pollTablet on a frame: OK with 0 notes -> frame OK; OK with notes -> notes imported once (frame 0, any f ignored), THAT frame remade; reviewing imports nothing', async (t) => {
  const { root, id, folder, work } = setup(t);
  const h = harness(t, root);
  await h.call('project.open', { id });
  const [v1, v2] = await queueFrames(root, id, ['sf01', 'sf02'], { media }).then((m) => m);
  const actions = { ask: null, frameOk: (f) => h.call('frames.ok', { frame: f }), frameFix: (f) => h.call('frames.fix', { frame: f }), approve: () => assert.fail('not a scene'), send: () => assert.fail('not a scene') };
  // reviewing: nothing is imported
  tablet(folder, v1, 'reviewing', [{ n: 1, id: 'a', f: 5, t: 0.2, text: 'wait', snap: 'snaps/a.jpg' }]);
  bump(); await pollTablet(root, id, { actions });
  assert.equal(listNotes(root, id).notes.length, 0);
  assert.equal(tabletEntries(root, id).find((e) => e.ref === 'sf01').t.status, 'reviewing');
  // done with 0 notes: the frame is OK'd
  tablet(folder, v1, 'done', []);
  bump(); assert.equal(await pollTablet(root, id, { actions }), true);
  assert.equal(loadFrames(work).frames[0].state, 'ok');
  assert.equal(tabletEntries(root, id).find((e) => e.ref === 'sf01').t.handled, true);
  // done with notes on sf02: imported once, at frame 0, then the frame is remade (fix)
  tablet(folder, v2, 'done', [{ n: 1, id: 'n1', f: 17, t: 0.6, text: 'Headline too small.', snap: 'snaps/n1.jpg' }]);
  bump(); await pollTablet(root, id, { actions }); bump(); await pollTablet(root, id, { actions });
  const mine = listNotes(root, id, 'sf02').notes;
  assert.equal(mine.length, 1); assert.equal(mine[0].frame, 0); assert.equal(mine[0].time, 0); assert.ok(mine[0].image && /\.jpg$/.test(mine[0].image)); assert.equal(mine[0].tablet, `${v2}/n1`);
  assert.equal(mine[0].pending, false); // sent with the fix
  assert.equal(loadFrames(work).frames[1].state, 'fix');
  assert.equal(loadFrames(work).frames[1].fix_notes[0].text, 'Headline too small.');
});

test('the app wins: a frame OK\'d in the app closes its tablet item; a tablet OK on a frame already settled only keeps the notes', async (t) => {
  const { root, id, folder, work } = setup(t);
  const h = harness(t, root);
  await h.call('project.open', { id });
  const [v1, v2] = await queueFrames(root, id, ['sf01', 'sf02'], { media });
  await h.call('frames.ok', { frame: 'sf01' }); // in the app
  assert.equal(JSON.parse(readFileSync(join(folder, v1, 'status.json'), 'utf8')).status, 'done');
  assert.equal(tabletEntries(root, id).find((e) => e.ref === 'sf01').t.closed_in_app, true);
  assert.equal(closeOnApp(root, id, 'sf01', 'frame'), false); // idempotent
  // sf02 is OK'd in the app, but a tablet note was already written: the tablet's OK keeps the note and does nothing else
  tablet(folder, v2, 'reviewing', [{ n: 1, id: 'n1', f: 0, text: 'late note' }]);
  await h.call('frames.ok', { frame: 'sf02' });
  assert.equal(listNotes(root, id, 'sf02').notes.length, 0); // the app won first: not imported
});

test('scenes keep working under the same map: the scene entry shows as scene:<beat>; the old save format is read unchanged', async (t) => {
  const { root, id } = setup(t);
  const { setSceneTablet } = await import('../src/svc/lessons.mjs');
  setSceneTablet(root, id, 'b01', { id: 'x1', status: 'to review', notes: 0, handled: false });
  assert.deepEqual(tabletEntries(root, id).map((e) => [e.key, e.kind, e.ref]), [['scene:b01', 'scene', 'b01']]);
});

import { spawnSync } from 'node:child_process';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('REAL ffmpeg: the compatibility video of a picture is a 1-second H.264 clip with silence, the poster and the image are written', { skip: !hasFfmpeg }, async (t) => {
  const { root, id, folder, work } = setup(t);
  const d = new Uint8Array(321 * 181 * 4).fill(200); // odd size on purpose
  writeFileSync(join(work, 'out', 'frames', 'real.png'), encodePng(321, 181, d));
  const vid = await queueImage(root, id, { kind: 'frame', ref: 'sf01', file: join(work, 'out', 'frames', 'real.png'), title: 'Real' });
  assert.ok(vid, 'queued');
  const it = queue(folder)[0];
  assert.equal(it.w, 321); assert.equal(it.h, 181);
  const pr = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', join(folder, vid, 'video.mp4')], { encoding: 'utf8' }).stdout);
  assert.equal(pr.streams[0].codec_name, 'h264'); assert.equal(pr.streams[0].width % 2, 0); assert.ok(Number(pr.format.duration) >= 0.9 && Number(pr.format.duration) <= 1.2);
  for (const f of ['image.png', 'poster.jpg', 'audio.wav']) assert.ok(existsSync(join(folder, vid, f)), f);
});
