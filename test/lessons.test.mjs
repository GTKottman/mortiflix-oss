import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, loadProject } from '../src/projects.mjs';
import { listLessons, proposeLesson, approveLesson, editLesson, toggleLesson, deleteLesson, restoreLesson, lessonsBlock, parseLearned, importLearned, saveNote, firstGet, firstApprove, firstPending } from '../src/svc/lessons.mjs';

const mkp = (root) => createProject(root, { pipeline: 'explainer', title: 'L', answers: { topic: 'x' } }).id;

test('propose -> approve (all) / project / edit / toggle / delete, no network', async (t) => {
  const root = tempStudio(t); const id = mkp(root);
  const p = await proposeLesson(root, id, { note: 'the title lands too hard', node: 's01', frame: 42, ask: async () => 'ok {"lesson":"Titles settle softly.","section":"Motion"}' });
  assert.equal(p.how, 'ai'); assert.equal(p.lesson.text, 'Titles settle softly.'); assert.equal(p.lesson.approved, false);
  assert.equal(lessonsBlock(root, id), '', 'not approved: not in prompts');
  const q = await proposeLesson(root, id, { note: 'too empty on the right', ask: async () => { throw new Error('offline'); } });
  assert.equal(q.how, 'words'); assert.equal(q.lesson.text, 'too empty on the right');
  approveLesson(root, id, p.lesson.id, 'all');
  approveLesson(root, id, q.lesson.id, 'project');
  const l = listLessons(root, id);
  assert.equal(l.counts.on, 2);
  assert.equal(listLessons(root, id, 'all').lessons.length, 1);
  assert.equal(listLessons(root, id, 'project').lessons.length, 1);
  assert.ok(existsSync(join(root, 'lessons.json')));
  assert.equal(editLesson(root, id, q.lesson.id, { text: 'Fill the frame.' }).lesson.text, 'Fill the frame.');
  const b = lessonsBlock(root, id);
  assert.match(b, /Titles settle softly/); assert.match(b, /Fill the frame/);
  assert.equal(listLessons(root, id).lessons.find((x) => x.id === p.lesson.id).used, 1);
  toggleLesson(root, id, p.lesson.id, false);
  assert.doesNotMatch(lessonsBlock(root, id), /Titles settle/);
  assert.equal(toggleLesson(root, id, p.lesson.id).lesson.on, true);
  deleteLesson(root, id, q.lesson.id);
  assert.equal(listLessons(root, id).counts.total, 1);
  assert.throws(() => deleteLesson(root, id, 'l-nope'), /no lesson/);
});

test('import reads the What Have We Learned bullets as approved, on, every-project lessons', (t) => {
  const root = tempStudio(t);
  const md = '# What have we learned\n\n## Process\n\n1. **Stills sign-off is not motion sign-off.** The order is: plan, stills. (Notional: I started the full render too early.)\n\n## Design\n\n6. **No dead space.** Fill the frame\n   with big type.\n- Flat grounds get texture.\n';
  const items = parseLearned(md);
  assert.equal(items.length, 3); assert.equal(items[1].text, 'No dead space. Fill the frame with big type.'); assert.equal(items[0].section, 'Process'); assert.match(items[0].note, /Notional/);
  const f = join(root, 'What Have We Learned - Test.md'); writeFileSync(f, md);
  assert.equal(importLearned(root, f).imported, 3);
  assert.equal(importLearned(root, f).imported, 0, 'one time: no doubles');
  const all = listLessons(root, null, 'all');
  assert.ok(all.lessons.every((x) => x.approved && x.on && x.scope === 'all'));
});

test('notes.save keeps the picture + audio, sends a fix and proposes a lesson', async (t) => {
  const root = tempStudio(t); const id = mkp(root);
  const fixes = [];
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const r = await saveNote(root, id, { node: 's01', time: 1.4, text: 'title too hard', image_png_base64: `data:image/png;base64,${png}`, audio_base64: Buffer.from('abc').toString('base64') }, { fix: (n, text) => { fixes.push([n, text]); return { edit: { id: 'e1' } }; }, ask: null });
  assert.ok(existsSync(r.note.image)); assert.ok(existsSync(r.note.audio)); assert.ok(r.note.image.includes('/notes/'));
  assert.equal(fixes[0][0], 's01'); assert.match(fixes[0][1], /title too hard[\s\S]*\.png/);
  assert.equal(r.lesson.source.node, 's01'); assert.equal(r.lesson.approved, false);
  assert.equal(r.note.frame, 42);
  await assert.rejects(() => saveNote(root, id, { node: 's01' }, {}), /needs words/);
});

test('scene 1 first: pending until approved, and it limits the animatic prompt', (t) => {
  const root = tempStudio(t); const id = mkp(root);
  const work = join(root, 'projects', id);
  mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: 'One.' }, { id: 'b02', words: 'Two.' }] }));
  assert.equal(firstPending(root, id), true);
  assert.equal(firstGet(root, id).approved, false); assert.equal(firstGet(root, id).beat, 'b01');
  assert.equal(firstApprove(root, id).approved, true);
  assert.equal(firstPending(root, id), false);
  assert.deepEqual(loadProject(root, id).mfx.motion_scenes.done, ['b01']);
});

test('lessons.edit scope moves a lesson between every project and only the project its note came from', async (t) => {
  const root = tempStudio(t); const a = mkp(root); const b = mkp(root);
  // a waiting lesson in project b's list whose note came from project a (the Lessons page showed "Only in <b>")
  const { lesson } = await proposeLesson(root, b, { note: 'keep titles still' });
  const fileB = join(root, 'state', b, 'lessons.json');
  writeFileSync(fileB, JSON.stringify(JSON.parse(readFileSync(fileB, 'utf8')).map((l) => ({ ...l, source: { ...l.source, project: a } }))));
  // "Only in" puts it in the project the note came from
  const only = approveLesson(root, b, lesson.id, 'project').lesson;
  assert.equal(only.scope, 'project'); assert.equal(only.project, a);
  assert.equal(listLessons(root, a, 'project').lessons.length, 1);
  assert.equal(listLessons(root, b, 'project').lessons.length, 0);
  assert.equal(listLessons(root, a).lessons[0].source.project_title, 'L');
  const all = editLesson(root, a, lesson.id, { scope: 'all', text: 'Keep titles still.' }).lesson;
  assert.equal(all.scope, 'all'); assert.equal(all.text, 'Keep titles still.');
  assert.equal(listLessons(root, a, 'project').lessons.length, 0);
  assert.equal(listLessons(root, b, 'all').lessons.length, 1);
  const back = editLesson(root, b, lesson.id, { scope: 'project' }).lesson;
  assert.equal(back.project, a, 'back to its own project, not the open one');
  assert.equal(listLessons(root, a, 'project').lessons[0].approved, true);
  assert.throws(() => editLesson(root, a, lesson.id, { scope: 'nowhere' }), /scope/);
});

test('lessons.delete is kept in the trash; lessons.restore puts it back where it was', async (t) => {
  const root = tempStudio(t); const id = mkp(root);
  const { lesson } = await proposeLesson(root, id, { note: 'fill the frame' });
  approveLesson(root, id, lesson.id, 'project');
  deleteLesson(root, id, lesson.id);
  assert.equal(listLessons(root, id).counts.total, 0);
  const r = restoreLesson(root, lesson.id).lesson;
  assert.equal(r.scope, 'project'); assert.equal(r.text, 'fill the frame'); assert.equal(r.approved, true);
  assert.equal(listLessons(root, id, 'project').lessons.length, 1);
  assert.throws(() => restoreLesson(root, lesson.id), /not in the trash/);
});
