// Cost first (src/svc/paidgate.mjs): a step that spends ElevenLabs never starts by itself. The runner pauses the
// project with needs_you {kind:'cost_ok'} and the voice it would use; step.confirm_cost lets it go on; the OK caps what
// is recorded; a scene's OK records nothing; the script's pace comes from the voice's measured takes. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { saveConfig, writeSecret, paths } from '../src/studio.mjs';
import { createProject, startProject, loadProject, projectPaths, update, readEvents } from '../src/projects.mjs';
import { Runner } from '../src/runner.mjs';
import { paidGate, confirmCost, askFirst, voiceBudget } from '../src/svc/paidgate.mjs';
import { voiceStepEstimate } from '../src/svc/voicecost.mjs';
import { recordLines } from '../src/soundtrack/voice.mjs';
import { voiceOnOk } from '../src/voiceonok.mjs';
import { speechPace, _clearPaceCache } from '../src/svc/pace.mjs';
import { castSet } from '../src/svc/voicecast.mjs';

const WORDS = ['Plymouth tried to cancel its cameras.', 'The cameras kept running.'];

function studioWithScript(t, config = {}) {
  const root = tempStudio(t, { backend: 'claude-code', voice: { engine: 'elevenlabs', elevenlabs: { voice_id: 'studio-voice', voice_name: 'Tracy K' } }, ...config });
  writeSecret(root, 'elevenlabs_api_key', 'test-key');
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('network call in a test'); };
  t.after(() => { globalThis.fetch = real; });
  const p = createProject(root, { pipeline: 'v3', title: 'Cost first', answers: { topic: 'Cameras', voice: 'Pick in the script step' } });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', name: 'Vote', words: WORDS[0] }, { id: 'b02', name: 'Running', words: WORDS[1] }] }));
  update(root, p.id, (x) => { x.steps = { brief: { state: 'approved', version: 1 }, script: { state: 'approved', version: 1 } }; x.state = 'queued'; });
  return { root, id: p.id, work, fetched: () => fetched };
}

test('the voice step waits for the OK on its cost: needs_you cost_ok with the estimate and the voice, nothing called', async (t) => {
  const { root, id, fetched } = studioWithScript(t);
  const chars = WORDS.join('').length;
  const e = voiceStepEstimate(root, id);
  assert.equal(e.credits_estimate, chars);
  assert.equal(e.voice.name, 'Tracy K');
  const runner = new Runner(root);
  runner.acquire(); t.after(() => runner.release());
  const r = await runner.runSession(id);
  assert.equal(r.paused, true);
  const p = loadProject(root, id);
  assert.equal(p.state, 'paused');
  assert.equal(p.needs_you.kind, 'cost_ok');
  assert.equal(p.needs_you.step, 'voice');
  assert.equal(p.needs_you.estimate_credits, chars);
  assert.equal(p.needs_you.voice.name, 'Tracy K');
  assert.match(p.needs_you.text, /Waiting for your OK on the cost/);
  assert.equal(p.session, null, 'no session started');
  assert.equal(fetched(), 0);
  assert.ok(!readEvents(root, id, { limit: 1000 }).some((x) => x.event === 'SESSION_STARTED'));
});

test('step.confirm_cost books the OK for the next version and queues the project; the gate lets it pass', (t) => {
  const { root, id } = studioWithScript(t);
  assert.ok(paidGate(root, id, { backend: 'claude-code' }));
  update(root, id, (p) => { p.state = 'paused'; p.needs_you = { kind: 'cost_ok', step: 'voice', text: 'x' }; });
  const r = confirmCost(root, id, 'voice');
  assert.equal(r.resumed, true);
  assert.equal(r.version, 1);
  const p = loadProject(root, id);
  assert.equal(p.state, 'queued');
  assert.equal(p.needs_you, null);
  assert.equal(p.cost_ok.voice.credits, WORDS.join('').length);
  assert.equal(paidGate(root, id, { backend: 'claude-code' }), null);
  assert.ok(voiceBudget(root, id) >= p.cost_ok.voice.credits);
  assert.throws(() => confirmCost(root, id, 'brief'), /step must be/);
});

test('a bigger plan than the credits OK\'d asks again', (t) => {
  const { root, id, work } = studioWithScript(t);
  confirmCost(root, id, 'voice');
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: `${WORDS[0]} ${'And then a much longer passage arrived. '.repeat(6)}` }] }));
  const g = paidGate(root, id, { backend: 'claude-code' });
  assert.ok(g && g.estimate_credits > loadProject(root, id).cost_ok.voice.credits);
});

test('paid.ask_first false: the old behaviour, no gate; the demo backend never gates', (t) => {
  const { root, id } = studioWithScript(t);
  assert.equal(askFirst(root), true);
  assert.equal(paidGate(root, id, { backend: 'demo' }), null);
  saveConfig(root, { paid: { ask_first: false } });
  assert.equal(askFirst(root), false);
  assert.equal(paidGate(root, id, { backend: 'claude-code' }), null);
});

test('the voice the estimate names is the project\'s cast narrator once one is picked', (t) => {
  const { root, id } = studioWithScript(t);
  castSet(root, id, [{ role: 'narrator', voice_id: 'picked-voice', name: 'Rachel' }]);
  const e = voiceStepEstimate(root, id);
  assert.deepEqual([e.voice.id, e.voice.name, e.voice.from], ['picked-voice', 'Rachel', 'cast']);
});

test('the OK is a budget: recordLines records nothing over it', async (t) => {
  const { work, fetched } = studioWithScript(t);
  const lines = WORDS.map((w, i) => ({ id: `b0${i + 1}-1`, text: w }));
  await assert.rejects(recordLines({ work, key: 'k', lines, voiceId: 'v', maxCredits: 10 }), (e) => e.code === 'over_budget');
  assert.equal(fetched(), 0);
});

test('a scene\'s OK records nothing while ask_first is on', (t) => {
  const { root, id, fetched } = studioWithScript(t);
  assert.equal(voiceOnOk(root, id, 'b01'), null);
  assert.equal(fetched(), 0);
});

test('the script pace comes from the voice\'s measured takes', (t) => {
  const { root } = studioWithScript(t);
  _clearPaceCache();
  assert.equal(speechPace(root).wpm, 120, 'nothing measured: 120 a minute');
  const take = (pid, voice, words, seconds) => {
    const dir = join(paths(root).projects, pid);
    mkdirSync(join(dir, 'voice'), { recursive: true }); mkdirSync(join(dir, 'sound', 'voice', 'lines'), { recursive: true });
    writeFileSync(join(dir, 'voice', 'timing.json'), JSON.stringify({ seconds, lines: [{ id: 'b01-1', words: Array.from({ length: words }, () => ({ text: 'w' })) }] }));
    writeFileSync(join(dir, 'sound', 'voice', 'lines', 'b01-1.json'), JSON.stringify({ voice_id: voice }));
  };
  take('p1', 'tracy', 146, 71.2); // the real Director 1 run: 123 a minute
  take('p2', 'other', 150, 60);
  _clearPaceCache();
  assert.equal(speechPace(root, { voiceId: 'tracy' }).wpm, 123);
  assert.equal(speechPace(root, { voiceId: 'tracy' }).from, 'voice');
  assert.equal(speechPace(root, { voiceId: 'nobody' }).from, 'studio');
  _clearPaceCache();
});

test('okNow: true only once the next version\'s cost is OK\'d', async (t) => {
  const { okNow } = await import('../src/svc/paidgate.mjs');
  const { root, id } = studioWithScript(t);
  assert.equal(okNow(root, id, 'voice'), false);
  confirmCost(root, id, 'voice');
  assert.equal(okNow(root, id, 'voice'), true);
});
