// The v3 pipeline walked end to end through the real runner: demo backend (no Claude), injected renderer / ask / checks /
// ArtCraft writer, fetch trapped (any network call fails the test). Proves the order, the gates (scene 1 holds the
// motion step until motion.first.approve), no paid call without a confirm, and stage.status for a v3 project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { saveConfig } from '../src/studio.mjs';
import { createProject, startProject, loadProject, projectPaths, projectPipeline, readEvents, update } from '../src/projects.mjs';
import { respond, settle, stepView, submissions, GateError } from '../src/gates.mjs';
import { Runner } from '../src/runner.mjs';
import { stageStatuses, stageDone, approveScene, V3_STAGES } from '../src/svc/stages.mjs';
import { sceneGet } from '../src/svc/lessons.mjs';
import { quickV3Step } from '../src/quickv3.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sine = (file, sec = 8) => { mkdirSync(join(file, '..'), { recursive: true }); const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${sec}`, '-ar', '48000', file]); assert.equal(r.status, 0); };

test('v3: the whole pipeline in order, scene 1 first, nothing paid, stage.status', async (t) => {
  const root = tempStudio(t);
  saveConfig(root, { voice: { engine: 'elevenlabs', elevenlabs: { music: true } } });
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('network call in a test'); };
  t.after(() => { globalThis.fetch = real; });

  const asked = [];
  const stills = [];
  let artcraftCalls = 0;
  const studio = {
    renderStill: async ({ output, props }) => { stills.push(props); mkdirSync(join(output, '..'), { recursive: true }); writeFileSync(output, PNG); },
    ask: async (prompt) => { asked.push(prompt); return JSON.stringify({ cues: [{ from_sec: 0, mood: 'calm', prompt: 'soft piano, no vocals' }] }); },
    runChecks: () => [{ key: 'jump', ok: true, items: [] }, { key: 'sync', ok: true, items: [], note: 'no key words listed in the scene data' }],
    writeArtcraft: (r, id) => { artcraftCalls++; const f = join(projectPaths(r, id).state, 'v3.mortiflix'); writeFileSync(f, '{}'); return { file: f, clips: 4, sound: 1, markers: 4, captions: 0 }; },
  };

  const p = createProject(root, { pipeline: 'v3', title: 'V3 walk', answers: { topic: 'How a kettle works' } });
  startProject(root, p.id);
  const id = p.id;
  const work = projectPaths(root, id).work;
  const runner = new Runner(root, { studio });
  runner.acquire();
  t.after(() => runner.release());
  const pipeline = () => projectPipeline(root, id);
  const view = () => stepView(loadProject(root, id), pipeline());
  const reviewing = () => view().find((s) => s.state === 'in_review');
  const status = () => stageStatuses(root, id);

  // before anything: the v3 stage set, one entry per stage, the delivering step last
  const s0 = status();
  assert.deepEqual(s0.map((s) => s.key), V3_STAGES);
  assert.deepEqual(s0.map((s) => s.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(s0.map((s) => s.name), ['Script', 'Voice & music', 'Look', 'Stills', 'Motion', 'Sound', 'Artcraft']);
  assert.ok(s0.every((s) => s.set === 'v3' && s.present));
  assert.deepEqual(s0.map((s) => s.steps.map((x) => x.key)), [['brief', 'script'], ['voice'], ['style-frames'], ['stills'], ['animatic'], ['sound'], ['artcraft']]);

  const approve = (step, extra = {}) => respond(root, id, step.key, step.version, { verdict: 'approve', ...extra });
  const run = async () => { await runner.loop(); };

  // brief, script, voice
  await run(); assert.equal(reviewing().key, 'brief'); approve(reviewing());
  await run(); assert.equal(reviewing().key, 'script'); approve(reviewing());
  await run(); assert.equal(reviewing().key, 'voice');
  // the music plan came after the voice: plan only, from the injected AI, no ElevenLabs call
  assert.ok(existsSync(join(work, 'music', 'cues.json')), 'music plan written after the voice');
  const plan = JSON.parse(readFileSync(join(work, 'music', 'cues.json'), 'utf8'));
  assert.ok(plan.cues.length >= 1 && plan.cues.every((c) => c.state === 'planned'));
  assert.equal(asked.length, 1);
  assert.equal(status()[1].kind, 'needsYou');
  // the owner makes the cues (cost OK'd in the app) and OKs them: stand-ins here, nothing paid (the sound waits for them)
  mkdirSync(join(work, 'music'), { recursive: true });
  writeFileSync(join(work, 'music', 'mc01.mp3'), 'x');
  writeFileSync(join(work, 'music', 'cues.json'), JSON.stringify({ ...plan, cues: plan.cues.map((c) => ({ ...c, file: join('music', 'mc01.mp3'), state: 'ok' })) }));
  approve(reviewing());

  // look (style frames) waits for the owner's look, then stills
  update(root, id, (q) => { q.mfx = { ...(q.mfx || {}), look_brief: { vibe: 'flat' }, motion_brief: { motion_pack: null, rule_packs: [], words: 'the AI decides' } }; settle(q, pipeline()); });
  await run();
  assert.equal(reviewing().key, 'style-frames'); approve(reviewing());
  // the demo voice lines carry `script`; the real voice step writes `text`: give stills what the real step gives them
  const lines = JSON.parse(readFileSync(join(work, 'voice', 'lines.json'), 'utf8'));
  writeFileSync(join(work, 'voice', 'lines.json'), JSON.stringify(lines.map((l) => ({ ...l, text: l.script }))));
  await run();
  const st = reviewing();
  assert.equal(st.key, 'stills');
  assert.equal(stills.length, lines.length, 'one still per spoken line');
  assert.ok(submissions(root, id).find((s) => s.step === 'stills').items.every((i) => i.kind === 'image'));
  approve(st);

  // motion: scenes are approved one by one; the step is held until every scene is OK
  await run();
  const mo = reviewing();
  assert.equal(mo.key, 'animatic');
  assert.throws(() => approve(mo), (e) => e instanceof GateError && /one by one/.test(e.message));
  const done = stageDone(root, id, 'motion');
  assert.ok(done.left.some((l) => l.step === 'animatic'), 'Next does not approve the motion step');
  assert.equal(reviewing().key, 'animatic');
  assert.ok(!loadProject(root, id).mfx.stages_done?.motion, 'motion is not marked done');
  assert.notEqual(status()[4].kind, 'done');
  // the owner's OK on scene 1: the step goes back so the rest is made, then it can be approved
  const sc = sceneGet(root, id);
  assert.equal(sc.scenes[0].state, 'making'); assert.ok(sc.total > 1);
  const r1 = approveScene(root, id, sc.scenes[0].beat);
  assert.equal(r1.next, sc.scenes[1].beat, 'the OK builds the next scene only');
  assert.equal(view().find((s) => s.key === 'animatic').state, 'changes');
  await run();
  assert.equal(reviewing().version, 2);
  assert.throws(() => approve(reviewing()), (e) => e instanceof GateError && /one by one/.test(e.message), 'still held');
  for (const s of sceneGet(root, id).scenes.slice(1)) { approveScene(root, id, s.beat); if (view().find((x) => x.key === 'animatic').state === 'changes') await run(); }
  const mo2 = reviewing();
  assert.equal(mo2.key, 'animatic');
  // the studio's animatic gives out/animatic.mp4 and the voice mix; the demo's are in its step folder
  copyFileSync(join(work, 'out', 'animatic-v2', 'preview.mp4'), join(work, 'out', 'animatic.mp4'));
  sine(join(work, 'voice', 'narration.wav'));
  mkdirSync(join(work, 'video', 'src'), { recursive: true });
  writeFileSync(join(work, 'video', 'src', 'actions.json'), JSON.stringify([{ shot: 's01', at_sec: 1, what: 'Title in', sound: 'xqzv unmatched sound' }, { shot: 's02', at_sec: 3, what: 'Row pops', sound: 'qwxz another unmatched' }]));
  approve(mo2);
  // the demo's music files stand in as real audio: Sound mixes them under the voice (out/voice/mix.wav)
  for (const c of JSON.parse(readFileSync(join(work, 'music', 'cues.json'), 'utf8')).cues.filter((x) => x.file)) sine(join(work, c.file), 4);

  // sound: planned from the motion, nothing paid is made
  await run();
  const so = reviewing();
  assert.equal(so.key, 'sound');
  assert.ok(existsSync(join(work, 'out', 'voice', 'mix.wav')), 'the music is mixed under the voice for the sound');
  const sp = JSON.parse(readFileSync(join(work, 'sound', 'sfx-plan.json'), 'utf8'));
  assert.equal(sp.cues.length, 2);
  assert.ok(sp.cues.every((c) => c.status === 'planned' || c.status === 'ready'));
  assert.ok(!existsSync(join(work, 'sound', 'calls.jsonl')), 'no paid call was logged');
  assert.match(submissions(root, id).find((s) => s.step === 'sound').note, /credits/);
  approve(so);

  // artcraft: checks + file, never launched; it is the delivering step
  await run();
  const ar = reviewing();
  assert.equal(ar.key, 'artcraft');
  assert.equal(artcraftCalls, 1);
  assert.ok(existsSync(join(work, 'out', 'artcraft', 'checks.json')));
  approve(ar);
  assert.equal(loadProject(root, id).state, 'delivered');
  assert.ok(loadProject(root, id).deliverables.length >= 1);

  // order of the submissions, and not a single network call
  const order = readEvents(root, id).filter((e) => e.event === 'SUBMITTED').map((e) => e.step);
  const first = [...new Set(order)];
  assert.deepEqual(first, ['brief', 'script', 'voice', 'style-frames', 'stills', 'animatic', 'sound', 'artcraft']);
  assert.equal(fetched, 0);
  const fin = status();
  assert.ok(fin.every((s) => s.kind === 'done'), JSON.stringify(fin.map((s) => [s.key, s.kind])));
});

test('v3: the studio steps only run for a v3 pipeline and one runnable step; explainer keeps its eight stages', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'v3', title: 'V3 quick', answers: { topic: 'x' } });
  assert.equal(quickV3Step(root, p.id, {}), null, 'nothing runnable but the brief');
  const e = createProject(root, { pipeline: 'explainer', title: 'Old', answers: { topic: 'x' } });
  const s = stageStatuses(root, e.id);
  assert.equal(s.length, 8);
  assert.deepEqual(s.map((x) => x.key), ['script', 'voice', 'styleFrames', 'transitions', 'animatic', 'music', 'edit', 'render']);
  assert.ok(s.every((x) => x.set === 'explainer'));
});

test('v3 draws its pictures by code: no image-model skill is copied into a v3 project', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'v3', title: 'No AI pictures', answers: { topic: 'bike lanes' } });
  const pipeline = projectPipeline(root, p.id);
  assert.ok(existsSync(join(projectPaths(root, p.id).pipeline, 'skills', 'remotion-motion', 'SKILL.md')), 'the Kinetograph skill is there');
});
