import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { graphView, pickVersion } from '../src/svc/graph.mjs';
import { runChecks } from '../src/svc/artcraft.mjs';

test('node.pick works on a voice line: older take plays, null goes back to the newest', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Pick Me', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'voice', 'clips'), { recursive: true });
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify([{ id: 'b01-1', text: 'Hello there.', file: 'voice/clips/b01-1.wav' }]));
  const wav = (n) => { const b = Buffer.alloc(52, n); b.write('RIFF', 0); b.writeUInt32LE(44, 4); b.write('WAVE', 8); return b; };
  writeFileSync(join(work, 'voice', 'clips', 'b01-1.wav'), wav(1));
  graphView(root, p.id);
  writeFileSync(join(work, 'voice', 'clips', 'b01-1.wav'), wav(2));
  const node = () => graphView(root, p.id).nodes.find((n) => n.id === 'b01-1');
  assert.equal(node().versions.length, 2);
  assert.deepEqual(pickVersion(root, p.id, 'b01-1', 1), { node: 'b01-1', plays: 1 });
  assert.equal(node().plays, 1);
  assert.equal(pickVersion(root, p.id, 'b01-1', null).plays, 2);
  assert.throws(() => pickVersion(root, p.id, 'b01-1', 9), /no v9/);
});

test('checks.run says checked:false with a reason when there is nothing to compare', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'No Animatic', answers: { topic: 'x' } });
  const r = runChecks(root, p.id);
  for (const c of r) { assert.equal(c.checked, false, c.key); assert.ok(c.reason, c.key); }
});

import { listLessons, saveNote } from '../src/svc/lessons.mjs';
import { voiceCheck } from '../src/svc/voicecast.mjs';
import { transcribeHandlers } from '../src/svc/transcribe.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('lessons.list: a lesson made from a note carries source.image', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Lessons', answers: { topic: 'x' } });
  const r = await saveNote(root, p.id, { node: 's01', time: 1, text: 'Too small.', image_png_base64: PNG });
  const l = listLessons(root, p.id, 'project').lessons.find((x) => x.id === r.lesson.id);
  assert.equal(l.source.image, r.note.image);
  assert.match(l.source.image, /\.png$/);
});

test('voice.check: words[] per line from timing.json, extra words flagged', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Words', answers: { topic: 'x' } });
  const dir = join(projectPaths(root, p.id).work, 'voice');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lines.json'), JSON.stringify([{ id: 'a01', text: 'Not fine at all.', script: 'Not fine at all.' }, { id: 'a02', text: 'Hi.', script: 'Hi.' }]));
  writeFileSync(join(dir, 'timing.json'), JSON.stringify({ lines: [{ id: 'a01', words: [['Not', 0, .2], ['fine', .2, .5], ['at', .5, .6], ['the', .6, .7], ['all.', .7, 1]].map(([text, start, end]) => ({ text, start, end })) }] }));
  const c = voiceCheck(root, p.id);
  assert.equal(c.lines[0].words.length, 5);
  assert.deepEqual(c.lines[0].words[3], { text: 'the', start: 0.6, end: 0.7, extra: true });
  assert.equal(c.lines[0].words[0].extra, false);
  assert.equal(c.lines[0].word_count, 4);
  assert.deepEqual(c.lines[1].words, []);
});

test('notes.transcribe: replies at once, the words arrive as an event, kept next to the recording (mocked model)', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Speak', answers: { topic: 'x' } });
  const saved = await saveNote(root, p.id, { node: 's01', time: 1, audio_base64: Buffer.from('fake').toString('base64'), audio_ext: 'webm' });
  const events = [];
  let calls = 0;
  const h = transcribeHandlers({ root, emit: (e, d) => events.push([e, d]), needProject: () => p.id, bad: (m) => { throw new Error(m); }, run: async () => { calls++; return { text: ' make it bigger ', language: 'en' }; } });
  const r = h['notes.transcribe']({ note: saved.note.id });
  assert.equal(r.job, 1);
  assert.equal(events.length, 0, 'not on the request chain');
  await new Promise((ok) => setTimeout(ok, 30));
  assert.equal(events[0][0], 'notes.transcribed');
  assert.equal(events[0][1].text, 'make it bigger');
  assert.equal(events[0][1].note, saved.note.id);
  h['notes.transcribe']({ note: saved.note.id });
  await new Promise((ok) => setTimeout(ok, 30));
  assert.equal(events[1][1].cached, true);
  assert.equal(calls, 1);
  assert.throws(() => h['notes.transcribe']({ audio: '/etc/passwd' }), /inside the project/);
  assert.throws(() => h['notes.transcribe']({}), /needs a note/);
  // a failing model is an event with the reason, not a crash
  const h2 = transcribeHandlers({ root, emit: (e, d) => events.push([e, d]), needProject: () => p.id, bad: (m) => { throw new Error(m); }, run: async () => { throw new Error('faster-whisper is not installed'); } });
  h2['notes.transcribe']({ note: saved.note.id, force: true });
  await new Promise((ok) => setTimeout(ok, 30));
  assert.match(events.at(-1)[1].error, /not installed/);
});
