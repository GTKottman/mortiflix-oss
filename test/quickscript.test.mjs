// The script in one quick call: when it's used, what it writes and submits, and the session it falls back to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, projectPaths, loadProject } from '../src/projects.mjs';
import { loadConfig } from '../src/studio.mjs';
import * as gates from '../src/gates.mjs';
import { quickScriptStep, quickScript, lengthSeconds, countWords } from '../src/quickscript.mjs';

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

function briefApproved(t) {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Bikes', answers: { topic: 'city bikes', length: '60 s' } });
  startProject(root, p.id);
  gates.submit(root, p.id, 'brief', { note: 'City bikes, 60 s.', questions: [{ id: 'tone', text: 'Tone?', default: 'Warm' }], items: [], error_checks: gates.stepChecks(root, p.id, 'brief').map((c) => ({ id: c.id, result: 'pass' })) });
  gates.respond(root, p.id, 'brief', 1, { verdict: 'approve' });
  return { root, id: p.id };
}

const beats = (n, each) => Array.from({ length: n }, (_, i) => ({ name: `Beat ${i + 1}`, words: words(each), visual: 'A bike.' }));
const answer = (structured) => async () => ({ ok: true, usage: { input_tokens: 8000, output_tokens: 2000 }, structured });

test('lengths and word counts', () => {
  assert.equal(lengthSeconds('60 s'), 60);
  assert.equal(lengthSeconds('2 min'), 120);
  assert.equal(lengthSeconds('20-30 min'), 1800);
  assert.equal(lengthSeconds('1:30'), 90);
  assert.equal(lengthSeconds('short'), null);
  assert.equal(countWords("Gödel's sentence: \"I cannot be proved.\" In 1931."), 8);
});

test('the script alone is next: one call writes, checks the length and submits it', async (t) => {
  const { root, id } = briefApproved(t);
  const config = loadConfig(root);
  const view = quickScriptStep(root, id, config);
  assert.equal(view?.key, 'script');
  assert.equal(quickScriptStep(root, id, { ...config, quickScript: false }), null);
  let fellBack = false;
  const r = await quickScript({ root, id, view, config, runArgs: {}, onActivity: () => {}, fallback: async () => { fellBack = true; return { ok: true }; },
    run: answer({ title: 'Bikes', intro: '60 s.', beats: beats(6, 20), note: 'First script.', facts_note: 'Checked.' }) });
  assert.equal(fellBack, false);
  assert.equal(r.ok, true);
  const work = projectPaths(root, id).work;
  assert.match(readFileSync(join(work, 'script.md'), 'utf8'), /### B01 · Beat 1\n\*A bike\.\*\n\nword0/);
  const b = JSON.parse(readFileSync(join(work, 'script', 'beats.json'), 'utf8')).beats;
  assert.deepEqual([b.length, b[0].id, b[5].id, b[0].target_sec], [6, 'b01', 'b06', 10]);
  assert.equal(loadProject(root, id).steps.script.state, 'in_review');
  const sub = gates.submissions(root, id).find((s) => s.step === 'script');
  assert.match(sub.error_checks.find((c) => c.id === 'script-fits-length').note, /120 words ÷ 120 per minute = 60 s/);
});

test('a script off the length gets one more try, then a session writes it', async (t) => {
  const { root, id } = briefApproved(t);
  const config = loadConfig(root);
  const prompts = [];
  let fellBack = false;
  const r = await quickScript({ root, id, view: quickScriptStep(root, id, config), config, runArgs: {}, onActivity: () => {},
    fallback: async () => { fellBack = true; return { ok: true, usage: { input_tokens: 1, output_tokens: 1 } }; },
    run: async (a) => { prompts.push(a.prompt); return answer({ title: 'B', intro: '', beats: beats(2, 100), note: 'n', facts_note: 'f' })(); } });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Your last try was 200 words \(100 s\)/);
  assert.equal(fellBack, true);
  assert.equal(r.usage.input_tokens, 16001);
  assert.equal(loadProject(root, id).steps.script?.state ?? 'ready', 'ready');
});

test('the owner\'s own script in input/ goes to a session', async (t) => {
  const { root, id } = briefApproved(t);
  const input = join(projectPaths(root, id).work, 'input');
  mkdirSync(input, { recursive: true });
  writeFileSync(join(input, 'my-script.txt'), 'Mine.');
  assert.equal(quickScriptStep(root, id, loadConfig(root)), null);
  assert.ok(existsSync(input));
});

test('the brief alone is next: one call restates it and asks the questions; files to read go to a session', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Bikes', answers: { topic: 'city bikes', length: '60 s' } });
  startProject(root, p.id);
  const { quickBriefStep, quickBrief, briefPrompt } = await import('../src/quickscript.mjs');
  const config = loadConfig(root);
  const view = quickBriefStep(root, p.id, config);
  assert.equal(view?.key, 'brief');
  assert.match(briefPrompt(root, p.id, view), /city bikes/);
  let fellBack = false;
  const r = await quickBrief({ root, id: p.id, view, config, runArgs: {}, onActivity: () => {}, fallback: async () => { fellBack = true; return { ok: true }; },
    run: answer({ note: 'What: city bikes.', research_notes: '- Bike shares started in 1965.', questions: [{ id: 'tone', text: 'Tone?', choices: ['Warm', 'Punchy'], default: 'warm ' }, { id: 'ending', text: 'Last card?', choices: [], default: 'The title' }] }) });
  assert.equal(fellBack, false);
  assert.equal(r.ok, true);
  const sub = gates.submissions(root, p.id).find((s) => s.step === 'brief');
  assert.deepEqual(sub.questions.map((q) => [q.id, q.default, q.choices]), [['tone', 'Warm', ['Warm', 'Punchy']], ['ending', 'The title', null]]);
  assert.equal(sub.items[0].label, 'Early research notes');
  assert.equal(loadProject(root, p.id).steps.brief.state, 'in_review');
  // the owner's own files: a session reads them
  const q = createProject(root, { pipeline: 'explainer', title: 'Mine', answers: { topic: 'x' } });
  startProject(root, q.id);
  mkdirSync(join(projectPaths(root, q.id).work, 'input'), { recursive: true });
  writeFileSync(join(projectPaths(root, q.id).work, 'input', 'notes.txt'), 'read me');
  assert.equal(quickBriefStep(root, q.id, config), null);
});
