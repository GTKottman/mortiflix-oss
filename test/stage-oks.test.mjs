// Dir1 bdb9 (2026-11-02): all 7 style frames OK'd, but stage.status said look ok 0, need 7 (needsYou) and the app's Next
// stayed locked ("7 of 7 looks still need your OK"). Look, Stills and Motion keep the owner's OKs in their own stores
// (design/frames-state.json, design/stills/stills.json, the motion scenes), and stage.status counts those. Next (stage.set
// done) then approves the step that is still in review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, loadProject, projectPaths, update } from '../src/projects.mjs';
import { stageStatuses, stageDone } from '../src/svc/stages.mjs';

function bdb9(t) {
  const root = tempStudio(t, { backend: 'claude-code' });
  const p = createProject(root, { pipeline: 'v3', title: 'Flock cameras', answers: { topic: 'Cameras', voice: 'Pick in the script step' } });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'design', 'stills'), { recursive: true }); mkdirSync(join(work, 'script'), { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: 'One.' }, { id: 'b02', words: 'Two.' }] }));
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify([{ id: 'b01-1', text: 'One.' }, { id: 'b02-1', text: 'Two.' }]));
  const frame = (n, state) => ({ id: `sf0${n}`, composition: `SF0${n}`, beats: ['b01'], label: `SF0${n}`, round: 1, state, current: 1, versions: [{ v: 1, file: `out/frames/sf0${n}-v1.png` }] });
  writeFileSync(join(work, 'design', 'frames-state.json'), JSON.stringify({ version: 1, planned: true, enough: false, frames: [1, 2, 3, 4, 5, 6, 7].map((n) => frame(n, 'ok')) }));
  update(root, p.id, (x) => {
    x.steps = { brief: { state: 'approved', version: 1 }, script: { state: 'approved', version: 1 }, voice: { state: 'approved', version: 1 },
      'style-frames': { state: 'in_review', version: 8, submitted_at: new Date().toISOString(), last_feedback: { version: 7, verdict: 'changes', notes: 0 } } };
    x.state = 'waiting';
  });
  const v8 = join(projectPaths(root, p.id).reviews, 'style-frames', 'v8');
  mkdirSync(v8, { recursive: true });
  writeFileSync(join(v8, 'submission.json'), JSON.stringify({ step: 'style-frames', version: 8, note: 'SF07 ends the video.', questions: [], items: [], error_checks: [], pin_changes: [], submitted_at: new Date().toISOString() }));
  return { root, id: p.id, work };
}
const look = (root, id) => stageStatuses(root, id).find((s) => s.key === 'look');

test('bdb9: every frame OK\'d in frames-state counts as OK; nothing needs the owner; Next approves the step', (t) => {
  const { root, id } = bdb9(t);
  const s = look(root, id);
  assert.deepEqual([s.ok, s.total, s.need], [7, 7, 0]);
  assert.notEqual(s.kind, 'needsYou');
  const r = stageDone(root, id, 'look');
  assert.deepEqual(r.left, [], JSON.stringify(r.left));
  assert.equal(loadProject(root, id).steps['style-frames'].state, 'approved', 'Next approves the step still in review');
});

test('frames in review count as needing the owner; skipped frames are not counted', (t) => {
  const { root, id, work } = bdb9(t);
  const st = JSON.parse(JSON.stringify({ version: 1, planned: true, frames: [] }));
  st.frames = [['ok'], ['review'], ['held'], ['skipped']].map(([state], i) => ({ id: `sf0${i + 1}`, state, current: 1, versions: [{ v: 1, file: 'x.png' }] }));
  writeFileSync(join(work, 'design', 'frames-state.json'), JSON.stringify(st));
  const s = look(root, id);
  assert.deepEqual([s.ok, s.total, s.need], [1, 3, 2]);
});

test('Stills count stills.json OKs; Motion counts approved scenes', (t) => {
  const { root, id, work } = bdb9(t);
  writeFileSync(join(work, 'design', 'stills', 'stills.json'), JSON.stringify({ lines: { 'b01-1': { state: 'ok', versions: [{ v: 1, file: 'a.png' }], current: 1 }, 'b02-1': { state: 'check', versions: [{ v: 1, file: 'b.png' }], current: 1 } } }));
  const stills = stageStatuses(root, id).find((s) => s.key === 'stills');
  assert.deepEqual([stills.ok, stills.total], [1, 2]);
  update(root, id, (x) => { x.mfx = { ...(x.mfx || {}), motion_scenes: { current: 1, done: ['b01'], built: ['b02'], mode: 'one' } }; });
  const motion = stageStatuses(root, id).find((s) => s.key === 'motion');
  assert.deepEqual([motion.ok, motion.total], [1, 2]);
});

// Dir2 d4fd (2026-11-02): 28 sounds OK'd, 1 cut, the sound step in review: stage.status said "1 needs you", ok 0 of 1
// (the step), so Next: Finish stayed locked. Sound counts sound/sfx-plan.json (cut sounds do not count).
test('d4fd: 28 sounds OK and 1 cut count as 28 of 28 OK, nothing needs the owner; Next approves the sound step', (t) => {
  const { root, id, work } = bdb9(t);
  mkdirSync(join(work, 'sound'), { recursive: true });
  const cues = Array.from({ length: 29 }, (_, i) => ({ id: `fx${String(i + 1).padStart(2, '0')}`, shot: 's01', status: i === 3 ? 'cut' : 'ok', source: 'library' }));
  writeFileSync(join(work, 'sound', 'sfx-plan.json'), JSON.stringify({ made: new Date().toISOString(), shots: ['s01'], cues }));
  update(root, id, (x) => {
    for (const k of ['style-frames', 'stills', 'animatic']) x.steps[k] = { state: 'approved', version: 1 };
    x.steps.sound = { state: 'in_review', version: 5, submitted_at: new Date().toISOString() };
  });
  const v5 = join(projectPaths(root, id).reviews, 'sound', 'v5');
  mkdirSync(v5, { recursive: true });
  writeFileSync(join(v5, 'submission.json'), JSON.stringify({ step: 'sound', version: 5, note: 'The sound.', questions: [], items: [], error_checks: [], pin_changes: [], submitted_at: new Date().toISOString() }));
  const s = stageStatuses(root, id).find((x) => x.key === 'sound');
  assert.deepEqual([s.ok, s.total, s.need], [28, 28, 0]);
  assert.notEqual(s.kind, 'needsYou');
  // one sound made and not decided: that one needs the owner
  cues[0].status = 'ready';
  writeFileSync(join(work, 'sound', 'sfx-plan.json'), JSON.stringify({ shots: ['s01'], cues }));
  const s2 = stageStatuses(root, id).find((x) => x.key === 'sound');
  assert.deepEqual([s2.ok, s2.total, s2.need], [27, 28, 1]);
  cues[0].status = 'ok';
  writeFileSync(join(work, 'sound', 'sfx-plan.json'), JSON.stringify({ shots: ['s01'], cues }));
  const r = stageDone(root, id, 'sound');
  assert.deepEqual(r.left, [], JSON.stringify(r.left));
  assert.equal(loadProject(root, id).steps.sound.state, 'approved');
});

test('Voice & music counts the voice lines and the music cues (music/cues.json)', (t) => {
  const { root, id, work } = bdb9(t);
  mkdirSync(join(work, 'music'), { recursive: true });
  writeFileSync(join(work, 'music', 'cues.json'), JSON.stringify({ cues: [{ id: 'mc01', state: 'ok' }, { id: 'mc02', state: 'made' }, { id: 'mc03', state: 'planned' }] }));
  const s = stageStatuses(root, id).find((x) => x.key === 'voiceMusic');
  assert.deepEqual([s.ok, s.total], [1, 5], '2 voice lines (not OK yet) + 3 cues (1 OK)');
});
