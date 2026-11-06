import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { lessonsBlock, pickLessons, LESSON_BUDGET } from '../src/svc/lessons.mjs';
import { reviewPrompt, fileHash } from '../src/quickanimatic.mjs';
import { deriveMotionData, motionConcurrency } from '../src/motiondata.mjs';

const mkp = (root) => createProject(root, { pipeline: 'explainer', title: 'L', answers: { topic: 'x' } }).id;
const SECS = ['Process', 'Design', 'Motion', 'Picture and words', 'Sound', 'Characters'];

test('T6: 200 lessons -> capped block, only the step sections, say how many more, wording kept', (t) => {
  const root = tempStudio(t); const id = mkp(root);
  const list = Array.from({ length: 200 }, (_, i) => ({ id: `l-${i}`, text: `Lesson number ${i} about ${SECS[i % 6]} ${'x'.repeat(60)}`, section: SECS[i % 6], on: true, approved: true, source: {}, used: 0 }));
  writeFileSync(join(root, 'lessons.json'), JSON.stringify(list));
  const b = lessonsBlock(root, id, { step: 'animatic', mark: false });
  const lines = b.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.join('\n').length <= LESSON_BUDGET, String(lines.join('\n').length));
  assert.ok(lines.length > 20 && lines.every((l) => /Motion|Picture and words|Process/.test(l)));
  assert.match(b, /\(\d+ more lessons for this step on the Lessons page\)/);
  assert.match(b, /not a process or a motion to copy/);
  assert.match(b, /^## Mistakes never to repeat/);
  assert.equal(lessonsBlock(root, id, { step: 'sound', mark: false }).includes('Design'), false);
});

test('T6: project lessons first, near duplicates once, no-section lessons reach every step, used counts only the included', (t) => {
  const root = tempStudio(t); const id = mkp(root);
  const mk = (i, text, section, used = 0) => ({ id: `a-${i}`, text, section, on: true, approved: true, source: {}, used });
  writeFileSync(join(root, 'lessons.json'), JSON.stringify([mk(1, 'Never blur the title.', 'Motion'), mk(2, 'never  blur the TITLE', 'Motion', 5), mk(3, 'Loud kicks hide the voice.', 'Sound'), mk(4, 'Keep one accent.', null)]));
  mkdirSync(projectPaths(root, id).state, { recursive: true });
  writeFileSync(join(projectPaths(root, id).state, 'lessons.json'), JSON.stringify([{ id: 'p-1', text: 'This project likes slow pushes.', section: 'Motion', on: true, approved: true, source: {}, used: 0 }]));
  const { chosen } = pickLessons(root, id, { step: 'animatic' });
  assert.deepEqual(chosen.map((l) => l.id), ['p-1', 'a-2', 'a-4']);
  const b = lessonsBlock(root, id, { step: 'animatic' });
  assert.doesNotMatch(b, /Loud kicks/);
  assert.match(lessonsBlock(root, id, { step: 'sound', mark: false }), /Keep one accent/);
  const all = JSON.parse(require_read(join(root, 'lessons.json')));
  assert.equal(all.find((l) => l.id === 'a-3').used, 0);
  assert.equal(all.find((l) => l.id === 'a-4').used, 1);
});
import { readFileSync } from 'node:fs';
const require_read = (f) => readFileSync(f, 'utf8');

test('T6: a lesson longer than the budget is still sent when it is the only one (never silently dropped)', (t) => {
  const root = tempStudio(t); const id = mkp(root);
  writeFileSync(join(root, 'lessons.json'), JSON.stringify([{ id: 'a', text: 'y'.repeat(500), section: 'Motion', on: true, approved: true, source: {}, used: 0 }]));
  assert.equal(pickLessons(root, id, { step: 'animatic', budget: 100 }).chosen.length, 1);
});

test('T9: later review rounds send only the changed files, the rest by hash', (t) => {
  const root = tempStudio(t); const id = mkp(root);
  const work = join(root, 'w');
  mkdirSync(join(work, 'video', 'src'), { recursive: true });
  writeFileSync(join(work, 'video', 'src', 'Main.tsx'), 'MAIN-V1');
  writeFileSync(join(work, 'video', 'src', 'ui.tsx'), 'UI-CODE');
  const c = { work, lines: [], script: { beats: [] }, project: { title: 'T' } };
  const files = ['src/Main.tsx', 'src/ui.tsx'];
  const r1 = reviewPrompt(c, files, 'sheet.png', '', null, []);
  assert.match(r1, /MAIN-V1/); assert.match(r1, /UI-CODE/);
  const sent = new Map(files.map((f) => [f, fileHash(work, f)]));
  writeFileSync(join(work, 'video', 'src', 'Main.tsx'), 'MAIN-V2');
  const full = files.filter((f) => sent.get(f) !== fileHash(work, f));
  const same = files.filter((f) => !full.includes(f)).map((f) => [f, fileHash(work, f)]);
  const r2 = reviewPrompt(c, full, 'sheet.png', '', null, same);
  assert.match(r2, /MAIN-V2/); assert.doesNotMatch(r2, /UI-CODE/);
  assert.match(r2, new RegExp(`src/ui.tsx \\(${fileHash(work, 'src/ui.tsx')}\\)`));
  assert.match(r2, /need_files/);
  assert.ok(r2.length < r1.length + 400);
});

// a long, mostly still scene: one title pops in at 60 and one caption at 400
const still = (f) => {
  const L = (id, x, text) => ({ id, type: 'text', opacity: 1, transform: { rotation: 0 }, bounds: { x, y: 100, width: 500, height: 60 }, text: { text } });
  return Promise.resolve({ width: 1920, height: 1080, fps: 30, layers: [{ id: 'bg', type: 'rect', opacity: 1, transform: {}, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, ...(f >= 60 ? [L('t', 100, 'Title here')] : []), ...(f >= 400 ? [L('c', 100, 'Caption here')] : [])] });
};
test('G2: coarse pass probes far fewer frames and finds the same actions', async () => {
  const count = (n) => { let k = 0; return { probe: (f) => { k++; return still(f); }, n: () => k }; };
  const a = count(), b = count();
  const fine = await deriveMotionData({ probe: a.probe, totalFrames: 600, coarse: 1 });
  const fast = await deriveMotionData({ probe: b.probe, totalFrames: 600 });
  assert.deepEqual(fast.actions, fine.actions);
  assert.deepEqual(fast.boxes, fine.boxes);
  assert.equal(fine.probes, a.n());
  assert.equal(fast.probes, b.n());
  assert.ok(fast.probes < fine.probes * 0.5, `${fast.probes} vs ${fine.probes}`);
  assert.ok(fast.skipped > 0);
});

test('G2: concurrency follows free RAM, 1..4', () => {
  assert.equal(motionConcurrency(64e9), 4);
  assert.equal(motionConcurrency(2e9), 1);
  assert.equal(motionConcurrency(5e9), 2);
});
