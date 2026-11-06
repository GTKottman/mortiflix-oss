// The v3 voice step makes the music too (RUN-BUGS Director 1, 2026-11-02: the voice was approved with no music; the plan
// after the voice only ran with Settings › Voice "Eleven Music" on, which is off by default). The plan is made whatever
// that switch says (free); making the cues waits for the cost OK; the step is not approved while its music is missing.
// No network: fetch is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { writeSecret } from '../src/studio.mjs';
import { createProject, startProject, loadProject, projectPaths, update } from '../src/projects.mjs';
import { respond } from '../src/gates.mjs';
import { musicExpected, musicHeld, musicUnplanned } from '../src/svc/musicneed.mjs';
import { fillV3Briefs } from '../src/svc/v3briefs.mjs';
import { quickSound } from '../src/quickv3.mjs';
import { stepView } from '../src/gates.mjs';
import { projectPipeline } from '../src/projects.mjs';
import { stepEstimate, confirmCost, okNow } from '../src/svc/paidgate.mjs';
import { planMusicAfterVoice } from '../src/quickv3.mjs';
import { musicHandlers, creditsFor } from '../src/svc/elmusic.mjs';

class PE extends Error { constructor(code, message) { super(message); this.code = code; } }
const PLAN = JSON.stringify({ cues: [
  { from_sec: 0, to_sec: 7, mood: 'calm', prompt: 'soft piano, no vocals', energy: 0.3, crossfade_sec: 1 },
  { from_sec: 7, to_sec: 20, mood: 'dark', prompt: 'low drone, no vocals', energy: 0.6, crossfade_sec: 1 }] });

function v3Project(t) {
  // the owner's settings: Eleven Music off for sessions (the default)
  const root = tempStudio(t, { backend: 'claude-code', voice: { engine: 'elevenlabs', elevenlabs: { voice_id: 'v', music: false } } });
  writeSecret(root, 'elevenlabs_api_key', 'test-key');
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network call in a test'); };
  t.after(() => { globalThis.fetch = real; });
  const p = createProject(root, { pipeline: 'v3', title: 'Music wanted', answers: { topic: 'Cameras', voice: 'Pick in the script step' } });
  startProject(root, p.id);
  const work = projectPaths(root, p.id).work;
  mkdirSync(join(work, 'script'), { recursive: true }); mkdirSync(join(work, 'voice'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: 'The city voted.' }, { id: 'b02', words: 'The cameras kept running.' }] }));
  writeFileSync(join(work, 'voice', 'timing.json'), JSON.stringify({ seconds: 20, lines: [{ id: 'b01-1', start: 0.5, end: 6 }, { id: 'b02-1', start: 7, end: 19.5 }] }));
  update(root, p.id, (x) => { x.steps = { brief: { state: 'approved', version: 1 }, script: { state: 'approved', version: 1 }, voice: { state: 'in_review', version: 1 } }; x.state = 'waiting'; });
  return { root, id: p.id, work };
}

function handlers(root, id, calls) {
  const work = projectPaths(root, id).work;
  const mp3 = join(work, 'fx.mp3');
  assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-ar', '44100', mp3]).status, 0);
  const fetchFn = async (url, init) => {
    if (/subscription/.test(String(url))) return { ok: false, status: 404 };
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => readFileSync(mp3).buffer.slice(0) };
  };
  return musicHandlers({ root, ProtocolError: PE, needProject: (p) => p?.project || id, fetchFn, ask: async () => PLAN });
}

test('a v3 project wants music; the voice step is not approved with no cue planned', (t) => {
  const { root, id } = v3Project(t);
  assert.equal(musicExpected(root, id), true);
  assert.match(musicHeld(root, id), /not planned/);
  assert.throws(() => respond(root, id, 'voice', 1, { verdict: 'approve' }), /makes the music too: the music is not planned/);
});

test('the plan follows the voice even with Eleven Music off in Settings (planning is free: no ElevenLabs call)', async (t) => {
  const { root, id, work } = v3Project(t);
  const j = await planMusicAfterVoice(root, id, { studio: { ask: async () => PLAN } });
  assert.equal(j.cues.length, 2);
  assert.equal(JSON.parse(readFileSync(join(work, 'music', 'cues.json'), 'utf8')).cues.length, 2);
  assert.match(musicHeld(root, id), /planned but not made: 2 of 2/);
  // planned is enough to approve the voice (Look goes on while the cues are made); this test has no submission
  assert.equal(musicUnplanned(root, id), null);
  assert.throws(() => respond(root, id, 'voice', 1, { verdict: 'approve' }), (e) => !/music/.test(e.message));
  // a second pass with cues there plans nothing new
  assert.equal(await planMusicAfterVoice(root, id, { studio: { ask: async () => { throw new Error('asked again'); } } }), null);
});

test('Make the music: the first music alone (cost first, booked on the voice step), the rest once it is OK\'d; then every cue OK approves', async (t) => {
  const { root, id } = v3Project(t);
  const calls = [];
  const h = handlers(root, id, calls);
  const plan = await h['music.plan.make']({});
  assert.equal(plan.expected, true);
  assert.equal(plan.enabled, true, 'the app may make cues: the voice step makes the music');
  const [c1, c2] = plan.cues.map((c) => c.credits);
  assert.equal(stepEstimate(root, id, 'music', { session: true }).estimate_credits, c1, 'only Music 1 is made first');
  // no confirm: an estimate, no call
  const ask = await h['music.make']({});
  assert.equal(ask.needs_confirm, true); assert.equal(ask.credits_estimate, c1); assert.deepEqual(ask.cues, ['mc01']); assert.equal(calls.length, 0);
  assert.match(ask.wait, /first music is made alone: hear Music 1/);
  assert.equal(okNow(root, id, 'music'), false);
  const ok = confirmCost(root, id, 'music');
  assert.equal(ok.step, 'music'); assert.equal(ok.credits, c1);
  assert.equal(okNow(root, id, 'music'), true);
  assert.equal(loadProject(root, id).cost_ok.music.version, 2, 'booked on the voice step');
  const r = await h['music.make']({ confirm: true });
  assert.deepEqual(r.made, ['mc01'], 'Dirs 1 and 2 made every cue at once: now only the first');
  assert.equal(calls.length, 1);
  // Music 1 made, not OK'd: the rest wait, and nothing is spent
  await assert.rejects(h['music.make']({ confirm: true }), (e) => e.code === 'first_music' && /hear Music 1 and OK it first/.test(e.message));
  assert.equal(stepEstimate(root, id, 'music', { session: true }), null, 'nothing to pay until Music 1 is OK\'d');
  assert.equal(calls.length, 1);
  await h['music.cue.ok']({ cue: 'mc01' });
  const rest = await h['music.make']({});
  assert.deepEqual(rest.cues, ['mc02']); assert.equal(rest.credits_estimate, c2); assert.equal(rest.wait, undefined);
  assert.deepEqual((await h['music.make']({ confirm: true })).made, ['mc02']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((b) => b.force_instrumental === true));
  assert.equal(stepEstimate(root, id, 'music', { session: true }), null, 'all made: nothing to pay');
  assert.match(musicHeld(root, id), /OK each cue \(1 left\)/);
  await h['music.cue.ok']({ cue: 'mc02' });
  assert.equal(musicHeld(root, id), null);
  // a second make has nothing left to make
  assert.deepEqual((await h['music.make']({ confirm: true })).made, []);
  assert.equal(calls.length, 2);
});

test('music.make takes a cue list; the first-music rule still holds', async (t) => {
  const { root, id } = v3Project(t);
  const h = handlers(root, id, []);
  await h['music.plan.make']({});
  assert.deepEqual((await h['music.make']({ cues: ['mc02'] })).cues, ['mc02'], 'nothing made: the one asked for, alone');
  assert.deepEqual((await h['music.make']({ cues: ['mc01', 'mc02'] })).cues, ['mc01']);
});

test('one cue made with Eleven Music off in Settings: allowed for the v3 voice step, still cost first', async (t) => {
  const { root, id } = v3Project(t);
  const calls = [];
  const h = handlers(root, id, calls);
  await h['music.plan.make']({});
  const est = await h['music.cue.make']({ cue: 'mc01' });
  assert.equal(est.needs_confirm, true); assert.equal(est.credits_estimate, creditsFor(8)); assert.equal(calls.length, 0);
  assert.equal((await h['music.cue.make']({ cue: 'mc01', confirm: true })).cue.state, 'made');
  assert.equal(calls.length, 1);
});

test('voice approved: Look starts with "the AI decides" when no look was picked (the v3 app asks for none); a pick is kept', (t) => {
  const { root, id } = v3Project(t);
  const look = () => stepView(loadProject(root, id), projectPipeline(root, id)).find((s) => s.key === 'style-frames').state;
  // voice still in review: nothing to fill, Look stays blocked
  assert.deepEqual(fillV3Briefs(root, id), []);
  update(root, id, (p) => { p.steps.voice = { state: 'approved', version: 1 }; });
  assert.equal(look(), 'blocked');
  assert.deepEqual(fillV3Briefs(root, id), ['look']);
  assert.equal(look(), 'ready');
  assert.match(loadProject(root, id).mfx.look_brief.words, /AI picks one from the brief/);
  assert.equal(loadProject(root, id).state, 'queued', 'the runner picks Look up');
  assert.deepEqual(fillV3Briefs(root, id), [], 'once only');
});

test('the Sound step waits for the music: needs_you says what is missing', async (t) => {
  const { root, id } = v3Project(t);
  const r = await quickSound({ root, id, view: {} });
  assert.equal(r.ok, false);
  const p = loadProject(root, id);
  assert.equal(p.state, 'paused');
  assert.match(p.needs_you.text, /The sound mixes the music, and the music is not planned yet/);
});

test('"the AI decides" keeps what the brief said about the look: the brief\'s look and tone answers go in the look brief', (t) => {
  const { root, id } = v3Project(t);
  update(root, id, (p) => { p.steps.voice = { state: 'approved', version: 1 }; p.mfx = { ...(p.mfx || {}), answers: {
    look: { step: 'brief', text: 'Which visual world?', answer: 'Chalk on a textured blackboard, then a cool, icy-blue molecular view' },
    tone: { step: 'brief', text: 'What tone?', answer: 'Playful myth-busting' },
    credit: { step: 'brief', text: 'How should the study be credited?', answer: 'A short on-screen line' } } }; });
  assert.deepEqual(fillV3Briefs(root, id), ['look']);
  const lb = loadProject(root, id).mfx.look_brief;
  assert.match(lb.words, /From the brief, the owner's own answers/);
  assert.match(lb.words, /Chalk on a textured blackboard, then a cool, icy-blue/);
  assert.match(lb.words, /Playful myth-busting/);
  assert.doesNotMatch(lb.words, /credited|No look was picked/);
  assert.match(lb.look, /Which visual world\? Chalk/);
  assert.match(readFileSync(join(projectPaths(root, id).work, 'design', 'look-brief.json'), 'utf8'), /icy-blue/);
});
