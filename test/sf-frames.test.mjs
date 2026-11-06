// Style frames v3, version 6: rounds of 3, the owner checks off EACH frame, lessons flow to the frames after, a lean prompt (A static / B / C).
// Everything the studio calls is mocked: NO AI, no Kinetograph, no paid call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { harness, put } from './sf-helpers.mjs';
import { createProject, projectPaths, projectPipeline, loadProject, update } from '../src/projects.mjs';
import { setBrief } from '../src/svc/lookbrief.mjs';
import { stepView, respond } from '../src/gates.mjs';
import { planFrames, framesView, nextAction, loadFrames } from '../src/svc/frames.mjs';
import { quickFramesStep, quickFrames, staticBlock, WRITE_SCHEMA, MAX_MEASURED_FIX } from '../src/quickframes.mjs';
import { encodePng } from '../src/svc/png.mjs';

const sc = (id, from, to, name = id) => ({ id, name, from_sec: from, to_sec: to });

test('plan: one frame per part, short parts share one, a long part holds its frame longer, rounds of 3', () => {
  const p = planFrames([sc('b01', 0, 8), sc('b02', 8, 10), sc('b03', 10, 12.5), sc('b04', 12.5, 40), sc('b05', 40, 46), sc('b06', 46, 53), sc('b07', 53, 60)]);
  assert.deepEqual(p.map((f) => f.beats), [['b01'], ['b02', 'b03', 'b04'], ['b05'], ['b06'], ['b07']]);
  assert.deepEqual(p.map((f) => f.hold_s), [8, 32, 6, 7, 7]); // no set length: the long part holds longer
  assert.deepEqual(p.map((f) => f.round), [1, 1, 1, 2, 2]);
  assert.deepEqual(p.map((f) => f.id), ['sf01', 'sf02', 'sf03', 'sf04', 'sf05']);
  assert.equal(planFrames([sc('b01', 0, 3), sc('b02', 3, 4)]).length, 1); // a very short video: one frame
  const many = planFrames(Array.from({ length: 30 }, (_, i) => sc(`b${String(i + 1).padStart(2, '0')}`, i * 6, i * 6 + 6)));
  assert.equal(many.length, 12); assert.equal(many.flatMap((f) => f.beats).length, 30);
  assert.equal(planFrames(Array.from({ length: 3 }, (_, i) => ({ id: `b0${i}`, name: 'x' }))).length, 3); // no timing: 6 s each
});

const BEATS = ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07'];
function studio(t) {
  const root = tempStudio(t, { backend: 'claude-code' });
  put(root, 'packs/style/aig/pack.json', JSON.stringify({ kind: 'style', name: 'Aig', palette: ['#fafafa', '#fd3a25'], style: { palette: [{ hex: '#fafafa', job: 'ground', rule: 'background' }, { hex: '#fd3a25', job: 'accent', rule: 'only on one word' }] } }));
  const p = createProject(root, { pipeline: 'v3', title: 'Black October', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  const w = (rel, d) => put(work, rel, typeof d === 'string' ? d : JSON.stringify(d));
  w('script/beats.json', { beats: BEATS.map((b, i) => ({ id: b, name: `Part ${i + 1}`, visual: 'v', lines: [{ id: `${b}-1`, words: `Words of ${b}.` }] })) });
  const T = [[0, 8], [8, 10], [10, 12.5], [12.5, 40], [40, 46], [46, 53], [53, 60]]; // the plan test's parts: 5 frames
  w('voice/timing.json', { seconds: 60, lines: BEATS.map((b, i) => ({ id: `${b}-1`, text: `Words of ${b}.`, start: T[i][0], end: T[i][1] })) });
  w('voice/lines.json', BEATS.map((b) => ({ id: `${b}-1`, text: `Words of ${b}.` })));
  w('.claude/skills/remotion-motion/setup.mjs', '');
  w('video/node_modules/.keep', '');
  w('video/src/video.ts', 'export const video = { width: 1920, height: 1080, fps: 30, seconds: 56 };');
  w('video/src/Main.tsx', 'export const Main = () => null;');
  setBrief(root, p.id, { pack: 'aig' });
  update(root, p.id, (x) => { for (const k of ['brief', 'script', 'voice']) x.steps[k] = { state: 'approved', version: 1 }; });
  return { root, id: p.id, work };
}

// mocks: the AI (writes a scene file per target frame), the render queue (writes a white picture with the text block), the inspect
function mocks(work, log) {
  const png = (name) => { const W = 400, H = 200, d = new Uint8Array(W * H * 4).fill(255); for (let y = 50; y < 90; y++) for (let x = 50; x < 250; x += 2) { const o = (y * W + x) * 4; d[o] = d[o + 1] = d[o + 2] = 10; } mkdirSync(join(work, 'out', 'frames'), { recursive: true }); writeFileSync(join(work, 'out', 'frames', `${name}.png`), encodePng(W, H, d)); };
  const run = async (a) => {
    const args = a.config.claudeArgs; const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    log.calls.push({ prompt: a.prompt, role: a.role, args, fix: /^(The studio MEASURED|The frames)/.test(a.prompt) });
    if (schema.required.includes('sections')) {
      const id = a.prompt.match(/Inspect the style frame (sf\d+)/)[1];
      const n = (log.inspected[id] = (log.inspected[id] || 0) + 1);
      const verdict = log.inspect ? log.inspect(id, n) : { pass: true };
      const sec = (pass, c) => ({ pass, note: 'looked', ...(pass ? {} : { correction: c }) });
      return { ok: true, usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 900 }, structured: {
        sections: { visual_design: sec(verdict.pass, 'Make the headline clearer'), typography: sec(true), technical_quality: sec(true), narrative_quality: sec(true), ...(/compare with the frame before it/.test(a.prompt) ? { transition_compatibility: sec(true) } : {}) },
        ...(verdict.pass ? {} : { files: [{ path: `src/scenes/${id}.tsx`, content: `import React from 'react';\nexport const ${id.toUpperCase()}: React.FC = () => <h1>Frame ${id} corrected ${n}</h1>;` }] }) } };
    }
    if (schema.required.includes('look_md')) {
      if (log.during) { const d = log.during; log.during = null; await d(); } // the owner acts while the run works
      const fixing = /## Remake these frames/.test(a.prompt);
      const ids = [...a.prompt.matchAll(fixing ? /### (sf\d+) \(/g : /### (sf\d+) \(composition/g)].map((m) => m[1]);
      return { ok: true, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: log.calls.length > 1 ? 4000 : 0 }, structured: {
        files: [{ path: 'src/ui.tsx', content: 'export const ui = 1;' }, ...ids.map((i) => ({ path: `src/scenes/${i}.tsx`, content: `import React from 'react';\nexport const ${i.toUpperCase()}: React.FC = () => <h1>Frame ${i} v${log.v}</h1>;` }))],
        frames: ids.map((i) => ({ id: i, why: `the peak of ${i}`, note: `what ${i} shows`, assets: ['tex:grain'] })), look_md: '# Look', note: 'A round.', facts_note: 'words checked' } };
    }
    return { ok: true, usage: { input_tokens: 10, output_tokens: 5 }, structured: { files: [{ path: 'src/ui.tsx', content: 'export const ui = 2;' }], note: 'x' } };
  };
  const jobs = [];
  const renders = { add: (j) => { jobs.push(j); for (const m of j.argv[2].matchAll(/-o \.\.\/out\/frames\/(\S+)\.png/g)) png(m[1]); return { id: jobs.length, state: 'done', exit_code: 0, output_tail: '' }; }, wait: async (id) => ({ id, state: 'done', exit_code: 0, output_tail: '' }) };
  const config = { quickFrames: true, _inspectProbe: async () => ({ width: 400, height: 200, layers: [{ id: 't', type: 'text', opacity: 1, bounds: { x: 50, y: 50, width: 200, height: 40 }, text: { text: '', lines: [{}] } }] }) };
  return { run, renders, config, jobs };
}

async function round(env, m, log) {
  const view = quickFramesStep(env.root, env.id, m.config);
  assert.ok(view, 'the studio does the step itself');
  const msgs = [];
  const r = await quickFrames({ root: env.root, id: env.id, view, run: m.run, runArgs: { env: {} }, config: m.config, onActivity: (a) => msgs.push(a.text), fallback: async (why) => { throw new Error(`gave up: ${why}`); }, renders: m.renders, sessionId: 's1' });
  assert.equal(r.ok, true);
  return { r, msgs };
}

test('a round writes 3 frames in one call (A static as a file, B+C as the message), renders and measures them, and waits for the owner', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const { msgs } = await round(env, m, log);
  const st = loadFrames(env.work);
  assert.deepEqual(st.frames.map((f) => f.state), ['review', 'review', 'review', 'todo', 'todo']); // 7 parts -> 5 frames, 2 rounds
  assert.equal(log.calls.filter((c) => /write 3 frames/.test(c.prompt)).length, 1); // one write call for the 3 frames
  assert.equal(log.calls.filter((c) => /^Inspect the style frame/.test(c.prompt)).length, 3); // then one fresh inspection call per frame
  const call = log.calls[0];
  assert.deepEqual(call.args.slice(-2), ['--append-system-prompt-file', join(env.root, 'run', 'quick', '_static', 'style-frame-writer.md')]);
  assert.equal(readFileSync(call.args.at(-1), 'utf8'), staticBlock()); // A is the file, byte for byte
  assert.ok(!/Black October/.test(staticBlock()), 'the static block has no project name');
  assert.match(staticBlock(), /Rule of Thirds/); assert.match(staticBlock(), /Break one only on purpose/);
  assert.match(call.prompt, /Black October/); assert.match(call.prompt, /#fd3a25 · accent: only on one word/); assert.match(call.prompt, /tex:halftone-dots/);
  assert.match(call.prompt, /### sf01 \(composition SF01/); assert.match(call.prompt, /### sf03 \(composition SF03/); assert.ok(!/### sf04 \(composition/.test(call.prompt));
  // measured, saved, versioned
  const f1 = st.frames[0];
  assert.equal(f1.current, 1); assert.equal(f1.versions[0].file, 'out/frames/sf01-v1.png'); assert.equal(f1.versions[0].measured.ok, true);
  assert.ok(existsSync(join(env.work, 'out', 'frames', 'sf01-v1.inspect.json')));
  assert.equal(f1.why, 'the peak of sf01');
  // the Root and the index the later steps read
  assert.match(readFileSync(join(env.work, 'video', 'src', 'scenes', 'frames.tsx'), 'utf8'), /frames: Record<string, React\.FC> = \{ SF01, SF02, SF03 \}/);
  // design/frames.json is the canvas's view: only the frames with a picture
  assert.deepEqual(JSON.parse(readFileSync(join(env.work, 'design', 'frames.json'), 'utf8')).frames.map((f) => f.id), ['sf01', 'sf02', 'sf03']);
  assert.ok(msgs.some((x) => /ready for your check.*read from the cache/.test(x)));
  assert.equal(st.rounds[0].round, 1);
  // the step is with the owner
  assert.equal(stepView(loadProject(env.root, env.id), projectPipeline(env.root, env.id)).find((s) => s.key === 'style-frames').state, 'in_review');
  const v = framesView(env.root, env.id);
  assert.equal(v.waiting_for, 'you'); assert.equal(v.total, 5); assert.equal(v.frames[0].hold_s, 8); assert.equal(v.frames[1].hold_s, 32);
});

test('the owner checks each frame; the notes on a frame become lessons and go into the frames written after; Fix remakes just that frame as a new version', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  // the Look cannot be approved while frames are open
  assert.throws(() => respond(env.root, env.id, 'style-frames', 1, { verdict: 'approve' }), /checked one by one/);
  // OK sf01; sf02 gets a note and a Fix
  assert.equal((await h.call('frames.ok', { frame: 'sf01' })).next, 'wait');
  await h.call('notes.save', { node: 'sf02', time: 0, text: 'The headline is too small; keep the red off the body text.', send: false });
  const fx = await h.call('frames.fix', { frame: 'sf02' });
  assert.equal(fx.notes, 1);
  let st = loadFrames(env.work);
  assert.deepEqual(st.frames.slice(0, 3).map((f) => f.state), ['ok', 'fix', 'review']);
  // the Fix is kept until every frame of the round has a decision: nothing restarts yet, and the owner is told it waits
  assert.equal(quickFramesStep(env.root, env.id, m.config), null, 'one Fix does not start a remake while sf03 waits');
  let fv = framesView(env.root, env.id);
  assert.equal(fv.fixes_waiting, 1); assert.equal(fv.frames[1].fix_sent, false); assert.equal(fv.waiting_for, 'you');
  // the last decision (OK sf03) sends the fixes: ONE restart, the words of every note in it
  const okLast = await h.call('frames.ok', { frame: 'sf03' });
  assert.equal(okLast.next, 'fixes'); assert.deepEqual(okLast.sent, ['sf02']);
  const fb = JSON.parse(readFileSync(join(env.work, 'feedback', 'style-frames-v1.json'), 'utf8'));
  assert.match(fb.overall, /sf02: The headline is too small; keep the red off the body text\./);
  log.v = 2;
  const view = quickFramesStep(env.root, env.id, m.config);
  assert.ok(view, 'the sent fixes restart the step and the studio remakes the frame itself');
  await round(env, m, log);
  const remake = log.calls.filter((c) => /^## The project/.test(c.prompt)).at(-1);
  assert.match(remake.prompt, /## Remake these frames/); assert.match(remake.prompt, /sf02/); assert.match(remake.prompt, /headline is too small/);
  assert.match(remake.prompt, /What the owner said on the frames before/);
  assert.ok(!/### sf01 \(/.test(remake.prompt) && !/### sf03 \(/.test(remake.prompt), 'only the fixed frame is remade');
  st = loadFrames(env.work);
  assert.deepEqual(st.frames.slice(0, 3).map((f) => [f.state, f.current, f.versions.length]), [['ok', 1, 1], ['review', 2, 2], ['ok', 1, 1]]); // old version kept
  assert.equal(st.frames[1].versions[0].notes, 1);
  assert.equal(st.frames[1].versions[1].file, 'out/frames/sf02-v2.png');
  // lessons: the note became a waiting lesson on this project
  assert.equal((await h.call('lessons.list', { scope: 'project' })).lessons.filter((l) => /headline/.test(l.text)).length, 1);
  // OK the last frames of round 1: the next round is written, 2 frames, with the notes on the frames before in its prompt
  const last = await h.call('frames.ok', { frame: 'sf02' });
  assert.equal(last.next, 'round');
  assert.ok(quickFramesStep(env.root, env.id, m.config));
  log.v = 3;
  await round(env, m, log);
  const r2 = log.calls.filter((c) => /^## The project/.test(c.prompt)).at(-1);
  // the inspector compares sf04 with the OK'd frame before it, and sf01 (nothing before it) with nothing
  assert.ok(log.calls.some((c) => /Inspect the style frame sf04/.test(c.prompt) && /compare with the frame before it/.test(c.prompt)));
  assert.ok(!log.calls.some((c) => /Inspect the style frame sf01/.test(c.prompt) && /compare with the frame before it/.test(c.prompt)));
  assert.match(r2.prompt, /### sf04 \(composition SF04/); assert.match(r2.prompt, /### sf05 \(composition SF05/); assert.ok(!/### sf01 \(composition/.test(r2.prompt));
  assert.match(r2.prompt, /On sf02: The headline is too small/); // lessons from the frames before go into the frames after
  assert.match(r2.prompt, /Frames the owner already OK'd/); assert.match(r2.prompt, /sf01/);
  // the static block is the same bytes in every call (the cache)
  const writers = log.calls.filter((c) => /^## The project/.test(c.prompt));
  assert.equal(new Set(writers.map((c) => readFileSync(c.args.at(-1), 'utf8'))).size, 1);
  // finish: OK both, then the Look can be approved
  for (const f of ['sf04', 'sf05']) await h.call('frames.ok', { frame: f });
  assert.equal(framesView(env.root, env.id).waiting_for, 'done');
  assert.equal(framesView(env.root, env.id).ok, 5);
});

test('"enough" stops the rounds: frames not made are skipped and the Look can be approved', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  for (const f of ['sf01', 'sf02']) await h.call('frames.ok', { frame: f });
  await h.call('frames.ok', { frame: 'sf03' });
  const e = await h.call('frames.enough');
  assert.deepEqual(e.frames.map((f) => f.state), ['ok', 'ok', 'ok', 'skipped', 'skipped']);
  assert.equal(nextAction(loadFrames(env.work)).kind, 'done');
  await assert.rejects(h.call('frames.ok', { frame: 'sf04' }), /skipped/);
  await assert.rejects(h.call('frames.ok', { frame: 'sf09' }), /no frame/);
});

test('measured checks that keep failing: 2 fixes with the measured report, then the frame is SHOWN held with the check result and the owner decides (OK anyway / Fix)', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  const tx = (id, y) => ({ id, type: 'text', opacity: 1, bounds: { x: 50, y, width: 200, height: 40 }, text: { text: '', lines: [{}] } });
  const bad = { ...m.config, _inspectProbe: async () => ({ width: 400, height: 200, layers: [tx('a', 50), tx('b', 64)] }) };
  const view = quickFramesStep(env.root, env.id, bad);
  const msgs = [];
  const r = await quickFrames({ root: env.root, id: env.id, view, run: m.run, runArgs: { env: {} }, config: bad, onActivity: (a) => msgs.push(a.text), fallback: async (w) => { throw new Error(`gave up: ${w}`); }, renders: m.renders, sessionId: 's' });
  assert.equal(r.ok, true, 'never a silent give-up');
  const fixes = log.calls.filter((c) => c.fix);
  assert.equal(fixes.length, MAX_MEASURED_FIX);
  assert.match(fixes[0].prompt, /## The measured report/); assert.match(fixes[0].prompt, /text a \(200×40 at 50,50\) and text b \(200×40 at 50,64\) overlap by 200×26 px/);
  assert.ok(!log.calls.some((c) => /^Inspect the style frame/.test(c.prompt)), 'no AI inspection on top of a failing measured check');
  assert.ok(msgs.some((x) => /shown to you with the check's result/.test(x)));
  const st = loadFrames(env.work);
  assert.deepEqual(st.frames.slice(0, 3).map((f) => f.state), ['held', 'held', 'held']);
  assert.match(st.frames[0].held[0], /^Studio check · no-collisions: 1 overlap: text a .* overlap by 200×26 px/);
  assert.equal(st.frames[0].versions[0].measured.ok, false);
  const v = await h.call('frames.get');
  assert.ok(v.frames[0].path.endsWith('out/frames/sf01-v1.png'), 'the picture is shown'); assert.equal(v.frames[0].state, 'held');
  // OK anyway
  const ok = await h.call('frames.ok', { frame: 'sf01' });
  assert.equal(ok.frames[0].state, 'ok'); assert.match(loadFrames(env.work).frames[0].versions[0].ok_anyway[0], /no-collisions/);
  // Fix with a note: the note AND the check result go to the remake
  await h.call('frames.fix', { frame: 'sf02', text: 'Move the title right.' });
  const f2 = loadFrames(env.work).frames[1];
  assert.equal(f2.state, 'fix'); assert.deepEqual(f2.fix_notes.map((n) => n.text.slice(0, 26)), ['Move the title right.', 'Studio check · no-collisio']);
  // Fix with no note on a held frame: the check result alone is the change
  await h.call('frames.fix', { frame: 'sf03' });
  assert.equal(loadFrames(env.work).frames[2].fix_notes.length, 1);
});

test('Fix on a frame in review with no note says what to do, and changes nothing', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  await assert.rejects(h.call('frames.fix', { frame: 'sf01' }), /Fix needs a note on sf01/);
  assert.equal(loadFrames(env.work).frames[0].state, 'review');
});

test('a render that keeps failing (no picture) ends in a plain pause, never a pass', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const renders = { add: () => ({ id: 1, state: 'failed', exit_code: 1, output_tail: 'boom' }), wait: async (id) => ({ id, state: 'failed', exit_code: 1, output_tail: 'boom' }) };
  const cfg = { ...m.config, _skipPreflight: true };
  const view = quickFramesStep(env.root, env.id, cfg);
  let why = null;
  await assert.rejects(quickFrames({ root: env.root, id: env.id, view, run: m.run, runArgs: { env: {} }, config: cfg, onActivity: () => {}, fallback: async (w) => { why = w; throw new Error('paused'); }, renders, sessionId: 's' }), /paused/);
  assert.match(why, /kept failing to render/);
  assert.equal(log.calls.filter((c) => c.fix).length, 3); // MAX_FIX fix calls
  assert.ok(loadFrames(env.work).frames.every((f) => f.state === 'todo'), 'nothing was marked made');
});

test('AI inspection: a failing section sends the corrections back and the frame is drawn again; 3 rounds that still fail HOLD the frame (never shown as passed) until the owner decides', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {}, inspect: (id, n) => ({ pass: id === 'sf01' ? n >= 2 : id !== 'sf02' }) }; // sf01 passes on round 2, sf02 never
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  assert.equal(log.inspected.sf01, 2); assert.equal(log.inspected.sf02, 3); assert.equal(log.inspected.sf03, 1);
  // the corrections reached the code and the picture was drawn again
  assert.match(readFileSync(join(env.work, 'video', 'src', 'scenes', 'sf01.tsx'), 'utf8'), /corrected 1/);
  const fixCall = log.calls.find((c) => /^Inspect the style frame sf01/.test(c.prompt));
  assert.match(fixCall.prompt, /Open .*sf01-v1\.png with Read/); assert.match(readFileSync(fixCall.args.at(-1), 'utf8'), /VISUAL DESIGN/); // INSPECTION.md is the static part
  assert.ok(!/Rule of Thirds/.test(readFileSync(fixCall.args.at(-1), 'utf8')));
  let st = loadFrames(env.work);
  assert.deepEqual(st.frames.slice(0, 3).map((f) => f.state), ['review', 'held', 'review']);
  assert.match(st.frames[1].held[0], /Visual design: Make the headline clearer/);
  assert.equal(st.frames[0].versions[0].inspection.rounds, 2); assert.equal(st.frames[1].versions[0].inspection.rounds, 3);
  const v = await h.call('frames.get');
  assert.equal(v.frames[1].state, 'held'); assert.equal(v.frames[1].inspection.sections.visual_design.pass, false); assert.ok(v.frames[1].path);
  // the owner sends it anyway (or OKs it anyway: frames.ok) ...
  const sent = await h.call('frames.send_anyway', { frame: 'sf02' });
  assert.equal(sent.frames[1].state, 'review'); assert.equal(sent.frames[1].inspection.sent_anyway, true);
  await assert.rejects(h.call('frames.send_anyway', { frame: 'sf01' }), /only a held frame/);
});

test('a held frame can be tried again: the unresolved items go back to the writer as corrections', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {}, inspect: (id, n) => ({ pass: id !== 'sf03' || log.v >= 2 }) };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  assert.equal(loadFrames(env.work).frames[2].state, 'held');
  for (const f of ['sf01', 'sf02']) await h.call('frames.ok', { frame: f });
  await h.call('frames.retry', { frame: 'sf03' }); // the round's last decision: sent at once
  log.v = 2;
  await round(env, m, log);
  const remake = log.calls.filter((c) => /## Remake these frames/.test(c.prompt)).at(-1);
  assert.match(remake.prompt, /Inspection: Visual design: Make the headline clearer/);
  const st = loadFrames(env.work);
  assert.equal(st.frames[2].state, 'review'); assert.equal(st.frames[2].current, 2);
});

test('V9: a note on a frame is a proposed lesson; once the owner approves it, every later frame prompt carries it as a mistake never to repeat; frames.get lists the notes', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  const saved = await h.call('notes.save', { node: 'sf01', time: 0, text: 'Never put the red on body copy.', send: false, image_png_base64: encodePng(2, 2, new Uint8Array(16)).toString('base64') });
  assert.ok(saved.lesson && saved.lesson.approved === false, 'a waiting lesson, the owner approves it');
  const v = await h.call('frames.get');
  assert.equal(v.frames[0].pending_notes, 1); assert.equal(v.frames[0].notes[0].text, 'Never put the red on body copy.'); assert.ok(v.frames[0].notes[0].image); assert.equal(v.lessons_waiting, 1);
  await h.call('lessons.approve', { id: saved.lesson.id, scope: 'project' });
  // OK with a note not sent is still OK (the note stays a lesson); the next frames get the lesson AND the note
  await h.call('frames.ok', { frame: 'sf01' }); await h.call('frames.ok', { frame: 'sf02' }); await h.call('frames.ok', { frame: 'sf03' });
  await round(env, m, log);
  const r2 = log.calls.filter((c) => /^## The project/.test(c.prompt)).at(-1).prompt;
  assert.match(r2, /Mistakes never to repeat/); assert.match(r2, /Never put the red on body copy/);
  assert.match(r2, /On sf01: Never put the red on body copy/);
});

test('pictures drawn before a run stopped (no version in the frame state, no session running) are shown with their check results, never "Failed"', async (t) => {
  const env = studio(t);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  const st = loadFrames(env.work);
  if (!st.planned) { const { ensurePlan } = await import('../src/svc/frames.mjs'); ensurePlan(env.work, BEATS.map((b, i) => ({ id: b, name: `Part ${i + 1}`, from_sec: i * 8, to_sec: i * 8 + 8 }))); }
  const s2 = loadFrames(env.work);
  for (const f of s2.frames.slice(0, 2)) f.state = 'writing';
  const { saveFrames } = await import('../src/svc/frames.mjs'); saveFrames(env.work, s2);
  // sf01: passes; sf02: a text 4 px from the left edge
  const W = 400, H = 200, d = new Uint8Array(W * H * 4).fill(255);
  for (const [i, x] of [[1, 50], [2, 4]]) {
    const img = new Uint8Array(d); for (let y = 50; y < 90; y++) for (let xx = x; xx < x + 200; xx += 2) { const o = (y * W + xx) * 4; img[o] = img[o + 1] = img[o + 2] = 10; }
    put(env.work, `out/frames/sf0${i}-v1.png`, '');
    writeFileSync(join(env.work, 'out', 'frames', `sf0${i}-v1.png`), encodePng(W, H, img));
    put(env.work, `out/frames/sf0${i}-v1.inspect.json`, JSON.stringify({ width: W, height: H, layers: [{ id: 't', type: 'text', opacity: 1, bounds: { x, y: 50, width: 200, height: 40 }, text: { text: '', lines: [{}] } }] }));
  }
  const v = await h.call('frames.get');
  assert.deepEqual(v.frames.slice(0, 3).map((f) => f.state), ['review', 'held', 'todo']);
  assert.ok(v.frames[0].path.endsWith('out/frames/sf01-v1.png')); assert.ok(v.frames[1].path.endsWith('out/frames/sf02-v1.png'));
  assert.match(v.frames[1].held[0], /^Studio check · text-safe-area/);
  assert.equal(v.frames[1].versions[0].ok, false);
  // they are the owner's to decide now
  assert.equal((await h.call('frames.ok', { frame: 'sf02' })).frames[1].state, 'ok');
});

test('Send N fixes: the owner sends the Fixes kept so far without deciding the other frames; each frame keeps its own notes', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  await h.call('frames.fix', { frame: 'sf01', text: 'Rougher paper, less vector.' });
  await h.call('frames.fix', { frame: 'sf02', text: 'Move the card off centre.' });
  assert.equal(quickFramesStep(env.root, env.id, m.config), null);
  await assert.rejects(h.call('frames.ok', { frame: 'sf01' }), /only a made frame/);
  const r = await h.call('frames.send_fixes');
  assert.deepEqual(r.sent, ['sf01', 'sf02']); assert.equal(r.fixes_waiting, 0);
  const fb = JSON.parse(readFileSync(join(env.work, 'feedback', 'style-frames-v1.json'), 'utf8'));
  assert.match(fb.overall, /sf01: Rougher paper, less vector\./); assert.match(fb.overall, /sf02: Move the card off centre\./);
  await assert.rejects(h.call('frames.send_fixes'), /No fix is waiting/);
  log.v = 2;
  await round(env, m, log);
  const remake = log.calls.filter((c) => /## Remake these frames/.test(c.prompt)).at(-1);
  assert.match(remake.prompt, /### sf01 [\s\S]*Rougher paper[\s\S]*### sf02 [\s\S]*Move the card off centre/);
});

test('decisions made while a run works are kept: an OK and a Fix (with its words) on other frames survive the run\'s save, and the Fix waits for the next send', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  await h.call('frames.fix', { frame: 'sf01', text: 'Rougher chalk.' });
  await h.call('frames.send_fixes');
  log.v = 2;
  log.during = async () => {
    await h.call('frames.ok', { frame: 'sf02' });
    await h.call('frames.fix', { frame: 'sf03', text: 'Keep the diagonal handoff.' });
  };
  await round(env, m, log);
  const st = loadFrames(env.work);
  assert.deepEqual(st.frames.slice(0, 3).map((f) => [f.id, f.state, f.current]), [['sf01', 'review', 2], ['sf02', 'ok', 1], ['sf03', 'fix', 1]]);
  assert.equal(st.frames[2].fix_notes[0].text, 'Keep the diagonal handoff.'); assert.ok(!st.frames[2].fix_sent_at, 'kept for the next send');
  // deciding sf01 (the last one waiting) sends sf03's words
  const r = await h.call('frames.ok', { frame: 'sf01' });
  assert.deepEqual(r.sent, ['sf03']);
  const fb = JSON.parse(readFileSync(join(env.work, 'feedback', 'style-frames-v2.json'), 'utf8'));
  assert.match(fb.overall, /sf03: Keep the diagonal handoff\./);
});

test('the same typed words saved twice on a frame (Enter and Fix together) are one note', async (t) => {
  const env = studio(t);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await h.call('notes.save', { node: 'sf02', time: 0, text: 'Move the card off centre.', send: false });
  const again = await h.call('notes.save', { node: 'sf02', time: 0, text: 'Move the card off centre.', send: false });
  assert.equal(again.same, true);
  assert.equal((await h.call('notes.list', { node: 'sf02' })).notes.length, 1);
});

test('a remake keeps what the owner asked for: the code fixer and the inspector get the frame\'s notes, which win over the checks', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  for (const f of ['sf01', 'sf03']) await h.call('frames.ok', { frame: f });
  await h.call('frames.fix', { frame: 'sf02', text: 'Put it on the ink ground, not cream paper.' }); // the round's last decision: sent
  // the remake's first render fails a measured check once, so the code fixer runs
  let first = true;
  const tx = (id, y) => ({ id, type: 'text', opacity: 1, bounds: { x: 50, y, width: 200, height: 40 }, text: { text: '', lines: [{}] } });
  const cfg = { ...m.config, _inspectProbe: async () => { const two = first; first = false; return { width: 400, height: 200, layers: two ? [tx('a', 50), tx('b', 64)] : [tx('a', 50)] }; } };
  log.v = 2;
  const view = quickFramesStep(env.root, env.id, cfg);
  await quickFrames({ root: env.root, id: env.id, view, run: m.run, runArgs: { env: {} }, config: cfg, onActivity: () => {}, fallback: async (w) => { throw new Error(w); }, renders: m.renders, sessionId: 's' });
  const fix = log.calls.find((c) => c.fix);
  assert.match(fix.prompt, /## What the owner asked for on these frames[\s\S]*sf02\n1\. Put it on the ink ground, not cream paper\./);
  assert.match(fix.prompt, /Never change the ground/);
  const insp = log.calls.filter((c) => /^Inspect the style frame sf02/.test(c.prompt)).at(-1);
  assert.match(insp.prompt, /Put it on the ink ground/); assert.match(insp.prompt, /IS explained: never ask to undo it/);
  // the owner's standing rule, alternate grounds: no prompt asks a frame back onto the ground of the one before (d4fd SF02:
  // "Same cream ledger paper as sf01, so the cut keeps its ground")
  assert.match(insp.prompt, /ALTERNATE the full-bleed background[\s\S]*never ask to put this frame on the ground of the one before/);
  assert.ok(!/whether any background or typography change/.test(insp.prompt));
  assert.match(fix.prompt, /never change a frame's ground \(its full-bleed background\), palette or layout to match another frame/);
  assert.match(staticBlock(), /ALTERNATE GROUNDS \(the owner's standing rule\)/);
});

test('the next round sees each OK\'d frame by its approved picture only, never a rejected older version', async (t) => {
  const env = studio(t);
  const log = { calls: [], v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await round(env, m, log);
  for (const f of ['sf01', 'sf03']) await h.call('frames.ok', { frame: f });
  await h.call('frames.fix', { frame: 'sf02', text: 'On ink.' });
  log.v = 2;
  await round(env, m, log); // sf02 v2
  const last = await h.call('frames.ok', { frame: 'sf02' });
  assert.equal(last.next, 'round');
  log.v = 3;
  await round(env, m, log);
  const r2 = log.calls.filter((c) => /^## The project/.test(c.prompt)).at(-1);
  assert.match(r2.prompt, /### sf04 \(composition SF04/);
  assert.match(r2.prompt, /- sf02: [^\n]*\n  Its approved picture: \S*out\/frames\/sf02-v2\.png/);
  assert.ok(!/sf02-v1\.png/.test(r2.prompt), 'the rejected version is never named');
  assert.match(r2.prompt, /older versions the owner rejected: never open them/);
});
