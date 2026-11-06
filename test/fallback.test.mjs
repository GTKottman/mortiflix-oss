// opt/fallback: T1 (a quick path that gives up pauses, one small repair call, no session), T3 (failure signatures, hard
// pause at the first GPU/login/billing failure, stop = pause, VRAM check before a model loads), T2 (code routes for edits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, loadProject, projectPaths, readEvents } from '../src/projects.mjs';
import { saveConfig, loadConfig } from '../src/studio.mjs';
import { Runner, BACKENDS } from '../src/runner.mjs';
import { failureSignature } from '../src/svc/failures.mjs';
import { makeFallback } from '../src/svc/giveup.mjs';
import * as gates from '../src/gates.mjs';
import { classifyEdit, routeOpenEdits } from '../src/svc/editroutes.mjs';
import { nodeAction, loadEdits, setEditState } from '../src/canvas.mjs';

// a real (tiny) WAV: the canvas treats anything else as "still being written"
const wav = (n) => { const b = Buffer.alloc(44 + 200); b.write('RIFF', 0); b.writeUInt32LE(36 + 200, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(200, 40); b.fill(n, 44); return b; };
const project = (t, pipeline = 'social-short') => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline, title: 'T', answers: { message: 'hi' } });
  startProject(root, p.id);
  return { root, id: p.id };
};

test('failure signatures', () => {
  assert.equal(failureSignature('RuntimeError: CUDA error: out of memory'), 'gpu');
  assert.equal(failureSignature('Please run /login'), 'login');
  assert.equal(failureSignature('Credit balance is too low'), 'billing');
  assert.equal(failureSignature('429 rate limit'), 'rate-limit');
  assert.equal(failureSignature('claude exited 143'), 'stopped');
  assert.equal(failureSignature('some typo in the code'), null);
});

test('T1: a quick path that gives up gets one repair call, then the project pauses; no session', async (t) => {
  const { root, id } = project(t);
  let sessions = 0;
  const prompts = [];
  const run = async (a) => { prompts.push(a.prompt); return { ok: true, usage: { input_tokens: 900, output_tokens: 100 }, structured: { cause: 'The loudness tool could not read the file.', next: 'Press Resume to try again.' } }; };
  const fb = makeFallback({ root, id, run, runArgs: {}, config: loadConfig(root), session: async () => { sessions++; return { ok: true }; }, label: 'voice' });
  const r = await fb('loudness: not measured');
  assert.equal(sessions, 0);
  assert.equal(prompts.length, 1);
  assert.equal(r.paused, true);
  assert.deepEqual(r.usage, { input_tokens: 900, output_tokens: 100 });
  const p = loadProject(root, id);
  assert.equal(p.state, 'paused');
  assert.match(p.needs_you.text, /loudness: not measured/);
  assert.match(p.needs_you.text, /Likely cause: The loudness tool/);
  assert.equal(p.needs_you.takeover, true);
  assert.ok(readEvents(root, id).some((e) => e.event === 'QUICK_GAVE_UP' && /loudness/.test(e.details)));
});

test('T1: no repair call for a machine failure or a missing tool; takeover and sessionFallback allow a session', async (t) => {
  const { root, id } = project(t);
  let calls = 0; let sessions = 0;
  const run = async () => { calls++; return { ok: true, structured: { cause: 'x', next: 'y' } }; };
  const mk = (config) => makeFallback({ root, id, run, runArgs: {}, config, session: async () => { sessions++; return { ok: true, usage: {} }; }, label: 'frames' });
  await mk(loadConfig(root))('CUDA error: out of memory');
  assert.equal(calls, 0);
  assert.equal(loadProject(root, id).needs_you.cause, 'gpu');
  await mk(loadConfig(root))('no render queue');
  assert.equal(calls, 0);
  assert.equal(sessions, 0);
  // owner pressed the button
  gates.takeover(root, id);
  assert.equal(loadProject(root, id).state, 'queued');
  await mk(loadConfig(root))('anything');
  assert.equal(sessions, 1);
  assert.equal(loadProject(root, id).mfx.takeover, undefined);
  // the studio setting
  await mk({ ...loadConfig(root), sessionFallback: true })('anything');
  assert.equal(sessions, 2);
});

test('T3: a GPU out-of-memory failure pauses after the first session, with the reason', async (t) => {
  const { root, id } = project(t);
  let runs = 0;
  BACKENDS.oom = { run: async () => { runs++; return { ok: false, error: 'CUDA error: out of memory' }; } };
  t.after(() => { delete BACKENDS.oom; });
  saveConfig(root, { backend: 'oom' });
  await new Runner(root).loop();
  assert.equal(runs, 1);
  const p = loadProject(root, id);
  assert.equal(p.state, 'paused');
  assert.equal(p.needs_you.cause, 'gpu');
  assert.match(p.needs_you.text, /graphics card ran out of memory/);
});

test('T3: the same other failure twice pauses; a stopped session is never restarted by itself', async (t) => {
  const a = project(t);
  let runs = 0;
  BACKENDS.flaky = { run: async () => { runs++; return { ok: false, error: 'rate limit 429' }; } };
  t.after(() => { delete BACKENDS.flaky; delete BACKENDS.halt; });
  saveConfig(a.root, { backend: 'flaky' });
  await new Runner(a.root).loop();
  assert.equal(runs, 2);
  assert.equal(loadProject(a.root, a.id).state, 'paused');

  const b = project(t);
  let stops = 0;
  const runner = new Runner(b.root);
  BACKENDS.halt = { run: async () => { stops++; runner.stopProject(b.id); return { ok: false, error: 'claude exited 143' }; } };
  saveConfig(b.root, { backend: 'halt' });
  await runner.loop();
  assert.equal(stops, 1);
  const p = loadProject(b.root, b.id);
  assert.equal(p.state, 'paused');
  assert.match(p.needs_you.text, /Press Resume/);
});

test('T3: a runner that died mid-session does not restart the project with "Carrying on"', (t) => {
  const { root, id } = project(t);
  const { update } = { update: null };
  void update;
  const f = join(root, 'projects');
  assert.ok(existsSync(f));
  const runner = new Runner(root);
  // mark it as running when the last runner died
  const pj = projectPaths(root, id);
  const j = JSON.parse(readFileSync(pj.project || join(pj.state, 'project.json'), 'utf8'));
  j.session = { running: true, id: 'x' };
  writeFileSync(pj.project || join(pj.state, 'project.json'), JSON.stringify(j));
  runner.acquire();
  t.after(() => runner.release());
  const p = loadProject(root, id);
  assert.equal(p.state, 'paused');
  assert.equal(p.needs_you.cause, 'stopped');
});

test('T2: which edits have a code route', () => {
  assert.deepEqual(classifyEdit({ kind: 'line', text: 'New take of this line (keep it inside its slot).' }), { route: 'retake' });
  assert.deepEqual(classifyEdit({ kind: 'line', text: 'Read this line again as written in voice/lines.json (role narrator, voice and settings from voice/cast.json), keeping it inside its slot.' }), { route: 'retake' });
  assert.deepEqual(classifyEdit({ kind: 'line', text: 'Change the words to: "Hello there.". Write them to voice/lines.json and the script beat, then make a new take.' }), { route: 'words', words: 'Hello there.' });
  assert.equal(classifyEdit({ kind: 'line', text: 'New take of this line: slower (keep it inside its slot).' }).route, 'note');
  assert.equal(classifyEdit({ kind: 'shot', text: 'New take of this line' }), null);
});

function withLine(t) {
  const root = tempStudio(t, { voice: { engine: 'elevenlabs' } });
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x', length: '60 s' } });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'voice', 'clips'), { recursive: true });
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify([{ id: 'b01-1', text: 'Hello world.', script: 'Hello world.' }, { id: 'b01-2', text: 'Second.', script: 'Second.' }]));
  writeFileSync(join(work, 'voice', 'clips', 'b01-1.wav'), wav(1));
  writeFileSync(join(work, 'voice', 'clips', 'b01-2.wav'), wav(2));
  return { root, id: p.id, work };
}

test('T2: a voice line retake runs one retake, touches only that line, and no AI call is made', async (t) => {
  const { root, id, work } = withLine(t);
  const e = nodeAction(root, id, 'b01-1', { action: 'fix', text: 'New take of this line (keep it inside its slot).' }).edit;
  const other = readFileSync(join(work, 'voice', 'clips', 'b01-2.wav'));
  let asked = 0; const lines = [];
  const r = await routeOpenEdits({ root, id, run: async () => { asked++; return { ok: true }; }, deps: { retake: async ({ line }) => { lines.push(line); writeFileSync(join(work, 'voice', 'clips', `${line}.wav`), wav(3)); return { ok: true }; } } });
  assert.deepEqual(r.handled, [e.id]);
  assert.deepEqual(lines, ['b01-1']);
  assert.equal(asked, 0);
  assert.ok(readFileSync(join(work, 'voice', 'clips', 'b01-2.wav')).equals(other));
  const done = loadEdits(root, id).find((x) => x.id === e.id);
  assert.equal(done.state, 'done');
  assert.equal(done.via, 'code');
  assert.equal(loadProject(root, id).canvas_edits, 0);
});

test('T2: new words go to lines.json first; a note is one small call; a vague note answers with a question; a failing route is not retried', async (t) => {
  const { root, id, work } = withLine(t);
  const retake = async ({ line }) => { writeFileSync(join(work, 'voice', 'clips', `${line}.wav`), wav(Math.floor(Math.random() * 200))); return { ok: true }; };
  const a = nodeAction(root, id, 'b01-1', { action: 'fix', text: 'Change the words to: "Hi, world.". Write them to voice/lines.json and the script beat, then make a new take.' }).edit;
  await routeOpenEdits({ root, id, deps: { retake } });
  const l = JSON.parse(readFileSync(join(work, 'voice', 'lines.json'), 'utf8'))[0];
  assert.deepEqual([l.text, l.script], ['Hi, world.', 'Hi, world.']);
  assert.equal(loadEdits(root, id).find((x) => x.id === a.id).state, 'done');

  const n = nodeAction(root, id, 'b01-2', { action: 'fix', text: 'New take of this line: slower please (keep it inside its slot).' }).edit;
  const seen = [];
  const run = async (args) => { seen.push(args); return { ok: true, usage: { input_tokens: 700, output_tokens: 40 }, structured: { text: 'Second... slowly.' } }; };
  const r = await routeOpenEdits({ root, id, run, config: loadConfig(root), deps: { retake } });
  assert.equal(seen.length, 1);
  assert.match(seen[0].prompt, /slower please/);
  assert.deepEqual(r.usage, { input_tokens: 700, output_tokens: 40 });
  assert.equal(JSON.parse(readFileSync(join(work, 'voice', 'lines.json'), 'utf8'))[1].text, 'Second... slowly.');
  assert.equal(loadEdits(root, id).find((x) => x.id === n.id).state, 'done');

  const q = nodeAction(root, id, 'b01-2', { action: 'fix', text: 'make it better' }).edit;
  await routeOpenEdits({ root, id, run: async () => ({ ok: true, structured: { question: 'Better how: warmer or faster?' } }), config: loadConfig(root), deps: { retake } });
  const qe = loadEdits(root, id).find((x) => x.id === q.id);
  assert.equal(qe.state, 'failed');
  assert.match(qe.note, /warmer or faster/);

  const f = nodeAction(root, id, 'b01-1', { action: 'fix', text: 'New take of this line.' }).edit;
  const bad = await routeOpenEdits({ root, id, deps: { retake: async () => ({ ok: false, why: 'tool broke' }) } });
  // a failed new take is finished as failed with the reason, never left to a session (its tools made an MP3 take too)
  assert.deepEqual(bad.left, []);
  assert.deepEqual(bad.failed, [f.id]);
  const fe = loadEdits(root, id).find((x) => x.id === f.id);
  assert.equal(fe.state, 'failed');
  assert.match(fe.note, /tool broke/);
  const again = await routeOpenEdits({ root, id, deps: { retake } });
  assert.deepEqual(again.handled, []);
});

test('T2: with editSession false, an edit no code route handles pauses with the AI button instead of starting a session', async (t) => {
  const root = tempStudio(t, { voice: { engine: 'elevenlabs' }, editSession: false });
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x', length: '60 s' } });
  startProject(root, p.id);
  let sessions = 0;
  BACKENDS.never = { run: async () => { sessions++; return { ok: true }; } };
  t.after(() => { delete BACKENDS.never; });
  saveConfig(root, { backend: 'never', editSession: false });
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'design'), { recursive: true });
  writeFileSync(join(work, 'voice-lines-placeholder'), '');
  // a shot edit has no route: build a node with a file the canvas reads
  mkdirSync(join(work, 'voice'), { recursive: true });
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify([{ id: 'b01-1', text: 'Hi.', script: 'Hi.' }]));
  mkdirSync(join(work, 'voice', 'clips'), { recursive: true });
  writeFileSync(join(work, 'voice', 'clips', 'b01-1.wav'), wav(1));
  // a note on a line is routed, so use a kind with no route: a cue-less project has none; fake by classifying through a stub edit
  const e = nodeAction(root, p.id, 'b01-1', { action: 'fix', text: 'New take of this line.' }).edit;
  // an edit no code route takes (a failed new take is finished as failed now, never left): give it an op
  setEditState(root, p.id, e.id, 'requested', { op: 'custom' });
  const r = await routeOpenEdits({ root, id: p.id, deps: { retake: async () => ({ ok: false, why: 'x' }) } });
  assert.deepEqual(r.left, [e.id]);
  await new Runner(root).loop();
  assert.equal(sessions, 0);
  const pj = loadProject(root, p.id);
  assert.equal(pj.state, 'paused');
  assert.equal(pj.needs_you.cause, 'needs-ai');
  assert.equal(pj.needs_you.takeover, true);
});

test('T1 through the runner: a failing quick script pauses the project; no session starts', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Bikes', answers: { topic: 'city bikes', length: '60 s' } });
  startProject(root, p.id);
  gates.submit(root, p.id, 'brief', { note: 'City bikes.', questions: [{ id: 'tone', text: 'Tone?', default: 'Warm' }], items: [], error_checks: gates.stepChecks(root, p.id, 'brief').map((c) => ({ id: c.id, result: 'pass' })) });
  gates.respond(root, p.id, 'brief', 1, { verdict: 'approve' });
  const calls = [];
  const was = BACKENDS['claude-code'];
  BACKENDS['claude-code'] = { run: async (a) => { calls.push(String(a.prompt)); return { ok: false, error: 'the model said no', usage: { input_tokens: 10, output_tokens: 1 } }; } };
  t.after(() => { BACKENDS['claude-code'] = was; });
  saveConfig(root, { backend: 'claude-code' });
  await new Runner(root).loop();
  assert.ok(calls.length >= 1);
  assert.equal(calls.filter((c) => c.startsWith("These are this project's start files")).length, 0, 'no full session');
  const pj = loadProject(root, p.id);
  assert.equal(pj.state, 'paused');
  assert.match(pj.needs_you.text, /quick script didn't work/);
  assert.ok(readEvents(root, p.id).some((e) => e.event === 'QUICK_GAVE_UP'));
});
