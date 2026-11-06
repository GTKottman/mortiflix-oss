import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { deriveMotionData, writeMotionData } from '../src/motiondata.mjs';
import { runChecks } from '../src/svc/artcraft.mjs';
import { actionsOf } from '../src/svc/sfx.mjs';

const ease = (f, a, b) => Math.min(1, Math.max(0, (f - a) / (b - a)));
// A fake scene graph: background, a title that fades in and slides over frames 30..45 and leaves at 120..130, a caption that
// pops in at frame 61 and stays, and a second text that sits on top of the caption from frame 90.
function probe(f) {
  const t = ease(f, 30, 45), out = 1 - ease(f, 120, 130);
  const L = (id, op, x, y, w, h, text, extra = {}) => ({ id, type: text ? 'text' : 'rect', opacity: op, transform: { rotation: 0 }, bounds: { x, y, width: w, height: h }, ...(text ? { text: { text } } : {}), ...extra });
  const layers = [
    L('bg', 1, 0, 0, 1920, 1080),
    { id: 'g', type: 'group', opacity: 1, children: [
      L('title', t * out, 100 + 200 * (1 - t) * 0 + 100 * (1 - t), 100, 600, 80, 'Three Rules'),
      ...(f >= 61 ? [L('cap', 1, 100, 600, 800, 60, 'Never panic quickly')] : []),
      ...(f >= 90 ? [L('over', 1, 300, 620, 800, 60, 'Overlapping line here')] : []),
    ] },
  ];
  return Promise.resolve({ width: 1920, height: 1080, fps: 30, durationInFrames: 150, frame: f, layers });
}
const scenes = [{ key: 's01', from_frame: 0, frames: 150 }];
const said = [{ w: 'three', at: 1.0 }, { w: 'rules', at: 1.3 }, { w: 'never', at: 2.1 }, { w: 'panic', at: 2.5 }];

test('motion data: actions start and end on their real frames, background skipped', async () => {
  const d = await deriveMotionData({ probe, totalFrames: 150, scenes, said });
  const appear = d.actions.find((a) => /Three Rules (slides in|appears)/.test(a.what));
  assert.ok(appear, JSON.stringify(d.actions));
  assert.equal(appear.at_frame, 31); // first frame whose picture differs (t > 0 at 31)
  assert.ok(appear.dur_frames >= 13 && appear.dur_frames <= 15, String(appear.dur_frames)); // settles at frame 45
  assert.equal(appear.shot, 's01');
  assert.ok(d.actions.some((a) => /Three Rules leaves/.test(a.what) && a.at_frame >= 120 && a.at_frame <= 122));
  const pop = d.actions.find((a) => /Never panic quickly appears/.test(a.what));
  assert.equal(pop.at_frame, 61);
  assert.ok(!d.actions.some((a) => /bg|Element/.test(a.what)));
});

test('motion data: key words at the frame they show, boxes with settled bounds and frame ranges', async () => {
  const d = await deriveMotionData({ probe, totalFrames: 150, scenes, said });
  // "Three Rules" is on screen (readable) from frame 38 (opacity 0.5); "three" is nearest to it
  const k = d.keys.find((x) => x.word === 'Three' || x.word === 'Rules');
  assert.ok(k && Math.abs(k.at_frame - 38) <= 1, JSON.stringify(d.keys));
  assert.ok(d.keys.some((x) => x.word === 'Never' && x.at_frame === 61));
  const title = d.boxes.find((b) => b.text === 'Three Rules');
  assert.deepEqual([title.x, title.w, title.h], [100, 600, 80]);
  assert.ok(title.from_frame >= 38 && title.from_frame <= 50 && title.to_frame >= 120 && title.to_frame <= 126, JSON.stringify(title));
  assert.equal(d.boxes.find((b) => b.text === 'Never panic quickly').from_frame, 61);
});

test('motion data: written for the checks and the sound; overlap and sync read it', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Motion', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'out'), { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true });
  const timing = { lines: [{ id: 'b01-1', start: 0.9, words: [{ text: 'Three', start: 1.0 }, { text: 'rules,', start: 1.9 }, { text: 'never', start: 2.1 }, { text: 'panic', start: 2.5 }] }] };
  writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify(timing));
  const sc = [{ key: 's01', from_frame: 0, frames: 150 }];
  const md = await writeMotionData({ work, scenes: sc, fps: 30, totalFrames: 150, timing, probe });
  assert.equal(md.ok, true);
  assert.ok(md.actions >= 3 && md.keys >= 2 && md.boxes === 3);
  writeFileSync(join(work, 'out', 'scenes.json'), JSON.stringify({ fps: 30, scenes: sc, motion_data: md }));
  // sound step reads the file
  const acts = actionsOf(work);
  assert.ok(acts.length >= 3 && acts.every((a) => a.shot === 's01' && a.dur_sec > 0));
  assert.equal(acts.find((a) => /Never panic/.test(a.what)).at_sec, 2.033);
  const checks = runChecks(root, p.id, { fps: 30 });
  const overlap = checks.find((c) => c.key === 'overlap');
  assert.equal(overlap.ok, false); // 'over' sits on 'cap' from frame 90
  assert.match(overlap.items[0].text, /Never panic quickly.*Overlapping line here/);
  assert.equal(overlap.items[0].at_sec, 3);
  const sync = checks.find((c) => c.key === 'sync');
  assert.equal(sync.ok, false); // "Three" shows at 38 (1.27 s), said at 1.0 s: late by more than 6 frames
  assert.match(sync.items[0].text, /after it is said/);
  assert.ok(!sync.unverified);
});

test('motion data: a failed read is recorded, stale actions removed, and the checks say it is unverified', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Motion', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'out'), { recursive: true }); mkdirSync(join(work, 'video', 'src'), { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true });
  writeFileSync(join(work, 'video', 'src', 'actions.json'), '[{"shot":"s01","at_sec":1,"what":"old"}]');
  const sc = [{ key: 's01', from_frame: 0, frames: 150 }];
  const md = await writeMotionData({ work, scenes: sc, fps: 30, totalFrames: 150, timing: { lines: [] }, probe: () => Promise.reject(new Error('no GPU')) });
  assert.equal(md.ok, false);
  assert.ok(!existsSync(join(work, 'video', 'src', 'actions.json')));
  writeFileSync(join(work, 'out', 'scenes.json'), JSON.stringify({ fps: 30, scenes: sc, motion_data: md }));
  const checks = runChecks(root, p.id, {});
  for (const k of ['sync', 'overlap']) {
    const c = checks.find((x) => x.key === k);
    assert.equal(c.unverified, true);
    assert.match(c.note, /not checked.*failed: no GPU/);
  }
  // an old animatic (no motion_data at all) says so too
  writeFileSync(join(work, 'out', 'scenes.json'), JSON.stringify({ fps: 30, scenes: [{ key: 's01', from_frame: 0, frames: 150 }] }));
  assert.match(runChecks(root, p.id, {}).find((x) => x.key === 'sync').note, /built before the studio read motion data/);
});
