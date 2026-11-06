// Smart options instead of chat (Redesign parts/95): options.get / options.run with the demo backend and a stand-in
// Claude Code (no network, no cost). Checks: defaults at once, one cheap call per state token, cache hits make no call,
// a run = a Fix on the piece (OK'd asks first), paid options need the cost confirm, stale ids are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { saveConfig } from '../src/studio.mjs';
import { syncCanvas } from '../src/canvas.mjs';
import { parseOptions, fitsStage } from '../src/svc/options.mjs';
import { update } from '../src/projects.mjs';
import { readRows } from '../src/svc/ledger.mjs';

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
function harness(t, root) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    const r = out.find((m) => m.id === id);
    if (!r.ok) { const e = new Error(`${type}: ${r.error.code}: ${r.error.message}`); e.code = r.error.code; throw e; }
    return r.result;
  };
  const events = (name) => out.filter((m) => m.event === name).map((m) => m.data);
  return { call, events };
}
async function until(fn, ms = 10_000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(25); } }

async function project(call, root) {
  const p = await call('project.new', { preset: 'explainer', title: 'Options', idea: 'x', start: false });
  const work = join(root, 'projects', p.project.id);
  mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: 'One.' }, { id: 'b02', words: 'Two.' }] }));
  syncCanvas(root, p.project.id);
  return p.project.id;
}

test('options: the demo backend shows the stage defaults at once and never calls the AI', async (t) => {
  const root = tempStudio(t);
  const { call } = harness(t, root);
  await project(call, root);
  const r = await call('options.get', { stage: 'script' });
  assert.equal(r.source, 'defaults');
  assert.equal(r.pending, false);
  assert.deepEqual(r.options.map((o) => o.label), ['Shorter', 'Stronger hook', 'Plainer words']);
  assert.ok(r.options.every((o) => o.id && o.does && !('_' in o)), 'the app gets id, label, does (no internals)');
  const one = await call('options.get', { stage: 'script', target: 'b01' });
  assert.match(one.options[0].does, /^Sends a Fix to B01: /);
  assert.equal((await call('options.get', { stage: 'finish' })).options.length, 0);
  await assert.rejects(call('options.get', { stage: 'chat' }), /bad_request/);
  await assert.rejects(call('options.get', { stage: 'script', target: '../x' }), /bad_request/);
});

test('options: a stand-in Claude makes them once per state token; same state = no call', async (t) => {
  const root = tempStudio(t);
  const bin = join(root, 'fake-claude');
  const calls = join(root, 'calls.log');
  writeFileSync(bin, `#!/bin/sh
case "$1" in
  -p) case "$2" in *"option buttons"*) ;; *) echo '{"type":"result","is_error":false,"result":"{}"}'; exit 0;; esac
      echo x >> "${calls}"
      case "$*" in *--model\\ haiku*) ;; *) echo "no haiku" >> "${calls}";; esac
      echo '{"type":"result","is_error":false,"modelUsage":{"claude-haiku-4-5":{"inputTokens":1,"outputTokens":2}},"result":"{\\"options\\": [{\\"label\\": \\"Punchier\\", \\"text\\": \\"Make it punchier.\\", \\"nodes\\": [\\"b01\\"]}, {\\"label\\": \\"Warmer\\", \\"text\\": \\"Warmer words.\\", \\"nodes\\": [\\"zz9\\"]}]}"}';;
esac
`);
  chmodSync(bin, 0o755);
  saveConfig(root, { backend: 'claude-code', claudeBin: bin });
  const { call, events } = harness(t, root);
  const id = await project(call, root);
  const nCalls = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0;

  const first = await call('options.get', { stage: 'script', target: 'b01' });
  assert.equal(first.source, 'defaults', 'answers at once with the defaults');
  assert.equal(first.pending, true);
  const ready = await until(() => events('options.ready')[0]);
  assert.deepEqual({ stage: ready.stage, target: ready.target, token: ready.token }, { stage: 'script', target: 'b01', token: first.token });
  assert.equal(readFileSync(calls, 'utf8').includes('no haiku'), false, 'runs on Haiku (role options)');

  const second = await call('options.get', { stage: 'script', target: 'b01' });
  assert.equal(second.source, 'cache');
  assert.deepEqual(second.options.map((o) => o.label), ['Punchier', 'Warmer']);
  assert.match(second.options[0].does, /Sends a Fix to B01: Make it punchier\./);
  assert.match(second.options[1].does, /^Tells the AI/, 'an unknown piece id is dropped');
  await call('options.get', { stage: 'script', target: 'b01' });
  await sleep(100);
  assert.equal(nCalls(), 1, 'nothing changed: no second call: ' + readFileSync(calls, 'utf8'));

  // Running one gives B01 a Fix, but the script step's version is the same: same token, no new call (no Haiku per reload).
  const r = await call('options.run', { id: second.options[0].id });
  assert.equal(r.done, true);
  assert.equal(r.edits.length, 1);
  const log = await call('chat.history');
  assert.ok(log.some((x) => x.role === 'action' && x.text === 'Punchier: Make it punchier.'), 'the run is in the project log the AI reads');
  await assert.rejects(call('options.run', { id: second.options[0].id }), /option is gone/);
  for (let i = 0; i < 5; i++) assert.equal((await call('options.get', { stage: 'script', target: 'b01' })).token, second.token);
  await sleep(100);
  assert.equal(nCalls(), 1, 'reloads and piece changes make no call');

  // A new version of the script step: new token, one new call.
  update(root, id, (p) => { p.steps = { ...p.steps, script: { ...(p.steps?.script || {}), state: 'in_review', version: (p.steps?.script?.version || 0) + 1 } }; });
  const third = await call('options.get', { stage: 'script', target: 'b01' });
  assert.notEqual(third.token, second.token);
  await until(() => events('options.ready').length === 2);
  assert.equal(nCalls(), 2);

  // The ledger books the call on the options' own stage, not the project's current one.
  await call('options.get', { stage: 'look' });
  await until(() => events('options.ready').length === 3);
  const rows = readRows(root).filter((x) => x.role === 'options');
  assert.deepEqual(rows.map((x) => x.stage), ['script', 'script', 'look']);
});

test('options: OK\'d pieces ask first, paid options need the cost confirm, whole-stage options become an instruction', async (t) => {
  const root = tempStudio(t);
  const { call } = harness(t, root);
  const id = await project(call, root);
  // OK'd piece: mark b01 OK in the owner file the canvas reads
  const { canvasPaths } = await import('../src/canvas.mjs');
  const cp = canvasPaths(root, id);
  const ownerFile = Object.values(cp).find((f) => typeof f === 'string' && /owner/i.test(f));
  assert.ok(ownerFile, 'canvas has an owner file');
  writeFileSync(ownerFile, JSON.stringify({ decisions: { b01: { verdict: 'ok', version: 1, at: new Date().toISOString() } } }));
  const o = (await call('options.get', { stage: 'script', target: 'b01' })).options[0];
  const asked = await call('options.run', { id: o.id });
  assert.equal(asked.asked, true);
  assert.match(asked.text, /B01 is OK'd\. Remake it anyway\?/);
  assert.equal((await call('options.run', { id: o.id, confirm: true })).done, true);

  const s = (await call('options.get', { stage: 'sound' })).options[0];
  assert.equal(s.cost.what, 'ElevenLabs sounds');
  await assert.rejects(call('options.run', { id: s.id }), /confirm the cost first/);
  const r = await call('options.run', { id: s.id, confirm_cost: true });
  assert.equal(r.done, true);
  assert.deepEqual(r.edits, []);
  assert.match(r.does, /^Tells the AI before its next work: /);
});

test('options: the answer parser takes JSON inside text and refuses anything else', () => {
  assert.deepEqual(parseOptions('Sure: {"options": [{"label": "A", "text": "b", "nodes": ["s01"]}]}'), [{ label: 'A', text: 'b', nodes: ['s01'] }]);
  assert.equal(parseOptions('no json'), null);
  assert.equal(parseOptions('{"options": 3}'), null);
});

test('options fit their stage: Look never offers script notes, and its defaults are about the look', async (t) => {
  for (const label of ['Stronger hook', 'Clearer pacing', 'Shorter', 'Plainer words']) {
    assert.equal(fitsStage('look', label), false, label);
    assert.equal(fitsStage('stills', label), false, label);
  }
  for (const label of ['Bolder colour', 'Less busy', 'More contrast', 'Different type', 'Closer to the brief']) assert.equal(fitsStage('look', label), true, label);
  assert.equal(fitsStage('script', 'Stronger hook'), true);
  const root = tempStudio(t);
  const { call } = harness(t, root);
  const id = await project(call, root);
  const look = await call('options.get', { project: id, stage: 'look' });
  assert.deepEqual(look.options.map((o) => o.label), ['Bolder colour', 'More contrast', 'Different type', 'Closer to the brief']);
});

test('a music cue on Voice & music gets music options, never voice reads', async (t) => {
  for (const label of ['Calmer read', 'Plainer wording', 'Remake this line', 'Slower read']) assert.equal(fitsStage('music', label), false, label);
  for (const label of ['Less busy', 'Darker', 'More pulse', 'Quieter under the voice', 'Different instrument']) assert.equal(fitsStage('music', label), true, label);
  const root = tempStudio(t);
  const { call } = harness(t, root);
  const id = await project(call, root);
  const work = join(root, 'projects', id);
  mkdirSync(join(work, 'music'), { recursive: true });
  writeFileSync(join(work, 'music', 'cues.json'), JSON.stringify({ cues: [{ id: 'mc02', from_sec: 10, to_sec: 20, prompt: 'Soft marimba', state: 'planned' }] }));
  const music = await call('options.get', { project: id, stage: 'voice', target: 'mc02' });
  assert.deepEqual(music.options.map((o) => o.label), ['Less busy', 'Darker', 'More pulse', 'Quieter under the voice']);
  assert.match(music.options[0].does, /Music 2 less busy/);
  const line = await call('options.get', { project: id, stage: 'voice', target: 'b01-1' });
  assert.equal(line.options[0].label, 'Slower', 'a voice line keeps the voice options');
});

test('Motion never offers the moves the owner\'s TASTE rejects (a fade, dissolve, wipe, iris or push)', () => {
  assert.equal(fitsStage('motion', 'Soft fade', 'Start and end this scene with a gentle fade instead of a hard cut.'), false);
  assert.equal(fitsStage('motion', 'Gentle start', 'Fade this scene in.'), false);
  assert.equal(fitsStage('motion', 'Calmer', 'Reduce the amount of movement in this scene.'), true);
  assert.equal(fitsStage('motion', 'Match cut', 'Carry the cut out of this scene with an element on screen that morphs into its match on the next screen.'), true);
  assert.equal(fitsStage('look', 'Softer fade', ''), true); // only Motion's moves
});
