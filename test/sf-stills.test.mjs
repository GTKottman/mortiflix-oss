// Style frames v3, version 13: stills drawn by Claude one scene (group) at a time, through the same measure + inspection path, with the
// owner's OK on each still and the last OK of a scene making the next scene. Every call is mocked: NO AI, no Kinetograph, no paid call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { harness, put } from './sf-helpers.mjs';
import { createProject, projectPaths, update } from '../src/projects.mjs';
import { setBrief } from '../src/svc/lookbrief.mjs';
import { respond } from '../src/gates.mjs';
import { quickV3Step, V3_RUN } from '../src/quickv3.mjs';
import { stillsView, stillGroups, stillsHeld, stillState } from '../src/svc/stills.mjs';
import { staticStills } from '../src/quickstills.mjs';
import { encodePng } from '../src/svc/png.mjs';

const LINES = { b01: ['Black October is here.', 'Four bugs are exploited.'], b02: ['Patch everything now.', 'Then check again.'], b03: ['That is the week.'] };
function studio(t) {
  const root = tempStudio(t, { backend: 'claude-code' });
  put(root, 'packs/style/aig/pack.json', JSON.stringify({ kind: 'style', name: 'Aig', palette: ['#fafafa', '#fd3a25'], style: { palette: [{ hex: '#fafafa', job: 'ground', rule: 'background' }, { hex: '#fd3a25', job: 'accent', rule: 'only on one word' }] } }));
  const p = createProject(root, { pipeline: 'v3', title: 'Black October', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  const w = (rel, d) => put(work, rel, typeof d === 'string' ? d : JSON.stringify(d));
  const beats = Object.keys(LINES);
  w('script/beats.json', { beats: beats.map((b, i) => ({ id: b, name: `Part ${i + 1}`, visual: 'v', lines: LINES[b].map((x, k) => ({ id: `${b}-${k + 1}`, words: x })) })) });
  const all = beats.flatMap((b) => LINES[b].map((x, k) => ({ id: `${b}-${k + 1}`, text: x })));
  w('voice/lines.json', all);
  w('voice/timing.json', { seconds: 30, lines: all.map((l, i) => ({ ...l, start: i * 5, end: i * 5 + 4 })) });
  w('.claude/skills/remotion-motion/setup.mjs', ''); w('video/node_modules/.keep', ''); w('video/src/video.ts', 'export const video = { width: 1920, height: 1080, fps: 30, seconds: 30 };');
  w('design/LOOK.md', '# Look\nRed only on one word.');
  setBrief(root, p.id, { pack: 'aig' });
  update(root, p.id, (x) => { for (const k of ['brief', 'script', 'voice', 'style-frames']) x.steps[k] = { state: 'approved', version: 1 }; });
  return { root, id: p.id, work };
}
function mocks(work, log) {
  const png = (name) => { const W = 400, H = 200, d = new Uint8Array(W * H * 4).fill(255); for (let y = 50; y < 90; y++) for (let x = 50; x < 250; x += 2) { const o = (y * W + x) * 4; d[o] = d[o + 1] = d[o + 2] = 10; } mkdirSync(join(work, 'design', 'stills'), { recursive: true }); writeFileSync(join(work, 'design', 'stills', `${name}.png`), encodePng(W, H, d)); };
  const run = async (a) => {
    const args = a.config.claudeArgs; const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    log.calls.push({ prompt: a.prompt, args, schema: schema.required.join(','), full: schema });
    if (log.fix && schema.required.join(',') === 'files,note') return log.fix(a, schema);
    if (schema.required.includes('sections')) {
      const id = a.prompt.match(/Inspect the still (b\d+-\d+)/)[1];
      const n = (log.inspected[id] = (log.inspected[id] || 0) + 1);
      const v = log.inspect ? log.inspect(id, n) : { pass: true };
      const sec = (pass, c) => ({ pass, note: 'looked', ...(pass ? {} : { correction: c }) });
      return { ok: true, usage: { input_tokens: 5, output_tokens: 5 }, structured: { sections: { visual_design: sec(v.pass, 'Make the key word bigger'), typography: sec(true), technical_quality: sec(true), narrative_quality: sec(true) }, ...(v.pass ? {} : { files: [{ path: `src/scenes/st_${id.split('-')[0]}.tsx`, content: `import React from 'react';\nexport const stills: Record<string, React.FC> = {\n  ${Object.entries(log.files[id.split('-')[0]]).map(([l, jsx]) => `'${l}': () => ${jsx}`).join(',\n  ')}\n}; // corrected ${n}` }] }) } };
    }
    if (schema.required.includes('stills')) {
      const fixing = /## Draw these stills again/.test(a.prompt);
      const beat = a.prompt.match(/src\/scenes\/st_(b\d+)\.tsx/)[1];
      const wanted = fixing ? [...a.prompt.matchAll(/### (b\d+-\d+): "([^"]*)"/g)].map((m) => [m[1], m[2]]) : [...a.prompt.matchAll(/^- (b\d+-\d+)[^:]*: "([^"]*)"/gm)].map((m) => [m[1], m[2]]);
      const prev = log.files[beat] || {};
      for (const [l, text] of wanted) prev[l] = `<h1>${text} (v${log.v})</h1>`;
      log.files[beat] = prev;
      const comps = Object.entries(prev).map(([l, jsx]) => `'${l}': () => ${jsx}`).join(',\n  ');
      return { ok: true, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: log.calls.length > 1 ? 3000 : 0 }, structured: { files: [{ path: `src/scenes/st_${beat}.tsx`, content: `import React from 'react';\nexport const stills: Record<string, React.FC> = {\n  ${comps}\n};` }], stills: wanted.map(([l]) => ({ line: l, why: `state of ${l}` })), note: 'The scene.', facts_note: 'words checked' } };
    }
    return { ok: true, usage: {}, structured: { files: [{ path: 'src/ui.tsx', content: 'x' }], note: 'x' } };
  };
  const renders = { add: (j) => { for (const m of j.argv[2].matchAll(/-o \.\.\/design\/stills\/(\S+)\.png/g)) png(m[1]); return { id: 1, state: 'done', exit_code: 0, output_tail: '' }; }, wait: async (id) => ({ id, state: 'done', exit_code: 0, output_tail: '' }) };
  const config = { _inspectProbe: async () => ({ width: 400, height: 200, layers: [{ id: 't', type: 'text', opacity: 1, bounds: { x: 50, y: 50, width: 200, height: 40 }, text: { text: '', lines: [{}] } }] }) };
  return { run, renders, config };
}
async function runGroup(env, m) {
  const view = quickV3Step(env.root, env.id, m.config);
  assert.equal(view?.key, 'stills', 'the stills step is next');
  const msgs = [];
  const r = await V3_RUN.stills({ root: env.root, id: env.id, view, studio: {}, onActivity: (a) => msgs.push(a.text), renders: m.renders, sessionId: 's', run: m.run, runArgs: { env: {} }, config: m.config, fallback: async (why) => { throw new Error(`gave up: ${why}`); } });
  assert.equal(r.ok, true);
  return msgs;
}
const lineStates = (v) => Object.fromEntries(v.lines.map((l) => [l.line, l.state]));

test('one scene at a time: scene 1 is written and checked, the other scenes are not touched; the static part carries the owner\'s STILLS.md', async (t) => {
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const msgs = await runGroup(env, m);
  const v = stillsView(env.root, env.id);
  assert.deepEqual(lineStates(v), { 'b01-1': 'check', 'b01-2': 'check', 'b02-1': 'todo', 'b02-2': 'todo', 'b03-1': 'todo' });
  assert.deepEqual(v.groups.map((g) => [g.beat, g.state]), [['b01', 'review'], ['b02', 'waiting'], ['b03', 'waiting']]);
  assert.equal(v.mode, 'groups'); assert.equal(v.lines[0].path, join(env.work, 'design/stills/b01-1-v1.png')); assert.equal(v.lines[0].check.key_word_visible, true);
  // one write call (A static in a file) + one inspection per still; nothing for the scenes after
  assert.equal(log.calls.filter((c) => c.schema.startsWith('files,stills')).length, 1);
  assert.equal(log.calls.filter((c) => c.schema === 'sections').length, 2);
  const write = log.calls[0];
  assert.match(write.prompt, /## This scene: b01 "Part 1"/); assert.match(write.prompt, /b01-1 \(initial state\): "Black October is here\." · key word: October/); assert.match(write.prompt, /b01-2 \(final state\)/);
  assert.ok(!/b02-1/.test(write.prompt));
  assert.match(write.prompt, /Red only on one word/); // the approved LOOK.md
  assert.equal(readFileSync(write.args.at(-1), 'utf8'), staticStills());
  assert.match(staticStills(), /Initial composition\./); assert.match(staticStills(), /Rule of Thirds/); assert.match(staticStills(), /one STATE of the scene/);
  // the studio wrote the roots Kinetograph draws
  assert.match(readFileSync(join(env.work, 'video/src/scenes/stills.tsx'), 'utf8'), /import \{ stills as s0 \} from '\.\/st_b01'/);
  assert.match(readFileSync(join(env.work, 'video/src/stills-root.tsx'), 'utf8'), /registerRoot/);
  assert.ok(msgs.some((x) => /Drawing scene 1 of 3: 2 stills/.test(x)));
  // measured + inspected, saved on the version
  const e = JSON.parse(readFileSync(join(env.work, 'design/stills/stills.json'), 'utf8')).lines['b01-1'];
  assert.equal(e.versions[0].measured.ok, true); assert.equal(e.versions[0].inspection.rounds, 1);
  assert.ok(existsSync(join(env.work, 'design/stills/b01-1-v1.inspect.json')));
  assert.equal(stillsHeld(env.root, env.id), true);
  assert.throws(() => respond(env.root, env.id, 'stills', 1, { verdict: 'approve' }), /checked a scene at a time/);
});

test('OK on each still; the last OK of a scene makes the NEXT scene, with the owner\'s notes on the stills before; a Fix draws only that still, again', async (t) => {
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await runGroup(env, m);
  // a note and a Fix on b01-2
  await h.call('notes.save', { node: 'b01-2', time: 0, text: 'The key word is lost: make it bigger.', send: false });
  const fx = await h.call('stills.fix', { line: 'b01-2' });
  assert.equal(fx.notes, 1);
  assert.deepEqual(lineStates(stillsView(env.root, env.id)), { 'b01-1': 'check', 'b01-2': 'fix', 'b02-1': 'todo', 'b02-2': 'todo', 'b03-1': 'todo' });
  const v1file = readFileSync(join(env.work, 'design/stills/b01-1-v1.png'));
  log.v = 2;
  await runGroup(env, m);
  const remake = log.calls.filter((c) => /## Draw these stills again/.test(c.prompt)).at(-1);
  assert.match(remake.prompt, /### b01-2: "Four bugs are exploited\."/); assert.match(remake.prompt, /The key word is lost: make it bigger/); assert.ok(!/### b01-1:/.test(remake.prompt));
  const v = stillsView(env.root, env.id);
  assert.deepEqual([v.lines[0].version, v.lines[1].version], [1, 2]); // b01-1 untouched, b01-2 a new version (the old kept)
  assert.ok(existsSync(join(env.work, 'design/stills/b01-2-v1.png')) && existsSync(join(env.work, 'design/stills/b01-2-v2.png')));
  assert.deepEqual(readFileSync(join(env.work, 'design/stills/b01-1-v1.png')), v1file);
  // OK both: the next scene is drawn, and only it
  assert.equal((await h.call('stills.ok', { line: 'b01-1' })).next, 'wait');
  const last = await h.call('stills.ok', { line: 'b01-2' });
  assert.equal(last.next, 'group');
  log.v = 3;
  await runGroup(env, m);
  const w2 = log.calls.filter((c) => /## This scene: b02/.test(c.prompt)).at(-1);
  assert.ok(w2, 'scene 2 is written now'); assert.ok(!/b03-1/.test(w2.prompt));
  assert.match(w2.prompt, /The key word is lost: make it bigger/); // the notes on scene 1 change how scene 2 is drawn
  assert.match(w2.prompt, /## The last still of the scene before/); assert.match(w2.prompt, /b01-2-v2\.png/);
  assert.deepEqual(stillGroups(env.root, env.id).map((g) => g.state), ['ok', 'review', 'waiting']);
  // finish: OK scene 2, draw scene 3, OK it: the step can be approved
  await h.call('stills.ok', { line: 'b02-1' }); await h.call('stills.ok', { line: 'b02-2' });
  await runGroup(env, m);
  assert.equal((await h.call('stills.ok', { line: 'b03-1' })).next, 'done');
  assert.equal(stillsHeld(env.root, env.id), false);
  // the static block is the same bytes for every write call (the cache)
  assert.equal(new Set(log.calls.filter((c) => c.schema.startsWith('files,stills')).map((c) => readFileSync(c.args.at(-1), 'utf8'))).size, 1);
});

test('Draw again on a still whose first draw failed (an error, no picture) draws it fresh, not a refusal', async (t) => {
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await runGroup(env, m);
  // the render of b01-2 failed: no version, the error kept, state check (as drawLines leaves it)
  const doc = stillState.load(env.root, env.id);
  Object.assign(doc.lines['b01-2'], { versions: [], current: null, state: 'check', error: 'render timed out' });
  stillState.save(env.root, env.id, doc);
  const r = await h.call('stills.fix', { line: 'b01-2' });
  assert.equal(r.fresh, true);
  const after = stillsView(env.root, env.id).lines.find((l) => l.line === 'b01-2');
  assert.equal(after.state, 'todo'); assert.ok(!after.error);
  // the group flow draws it as a new still (version 1), the other still untouched
  await runGroup(env, m);
  const v = stillsView(env.root, env.id);
  assert.equal(v.lines[1].state, 'check'); assert.equal(v.lines[1].version, 1); assert.equal(v.lines[0].version, 1);
  // a line with no picture and no error still has nothing to fix
  await assert.rejects(h.call('stills.fix', { line: 'b02-1' }), /has no still to fix/);
});

test('a still the inspection cannot satisfy is HELD until the owner OKs it anyway, sends it anyway or has it drawn again', async (t) => {
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {}, inspect: (id) => ({ pass: id !== 'b01-2' }) };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await runGroup(env, m);
  assert.equal(log.inspected['b01-2'], 3);
  const v = await h.call('stills.get');
  assert.equal(v.lines[1].state, 'held'); assert.match(v.lines[1].held[0], /Visual design: Make the key word bigger/); assert.equal(v.groups[0].state, 'review');
  // OK on a held still is the owner's OK anyway (stills.ok); here it is sent to check first
  const r = await h.call('stills.send_anyway', { line: 'b01-2' });
  assert.equal(r.state, 'check');
  assert.equal((await h.call('stills.ok', { line: 'b01-2' })).line, 'b01-2');
  await assert.rejects(h.call('stills.retry', { line: 'b01-1' }), /not held/);
});

test('without a Claude backend the old template path still runs (demo, tests): no calls', async (t) => {
  const env = studio(t);
  const calls = [];
  const view = quickV3Step(env.root, env.id, {});
  const r = await V3_RUN.stills({ root: env.root, id: env.id, view, studio: { renderStill: async ({ output }) => { mkdirSync(join(output, '..'), { recursive: true }); writeFileSync(output, 'png'); } }, onActivity: () => {}, renders: null, sessionId: 's', run: async () => { calls.push(1); } });
  assert.equal(r.ok, true); assert.equal(calls.length, 0);
});

test('the code fixer may write the still scene file (st_b01.tsx), never the studio scaffold', async (t) => {
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const text = (id, y) => ({ id, type: 'text', opacity: 1, bounds: { x: 50, y, width: 200, height: 40 }, text: { text: id, lines: [{}] } });
  let fixed = false;
  m.config._inspectProbe = async () => ({ width: 400, height: 200, layers: fixed ? [{ ...text('t', 50), text: { text: '', lines: [{}] } }] : [text('a', 50), text('b', 60)] });
  log.fix = (a, schema) => { fixed = true; return { ok: true, usage: {}, structured: { files: [{ path: 'src/scenes/st_b01.tsx', content: readFileSync(join(env.work, 'video/src/scenes/st_b01.tsx'), 'utf8') }], note: 'moved b apart' } }; };
  await runGroup(env, m);
  const fix = log.calls.find((c) => c.schema === 'files,note');
  assert.ok(fix, 'the measured collision went to the code fixer');
  assert.match(fix.prompt, /## The measured report/);
  const re = (sc) => new RegExp(sc.properties.files.items.properties.path.pattern);
  for (const sc of [fix.full, log.calls.find((c) => c.schema === 'sections').full]) {
    assert.ok(re(sc).test('src/scenes/st_b01.tsx') && re(sc).test('src/ui.tsx'));
    for (const no of ['src/scenes/sf01.tsx', 'src/stills-root.tsx', 'src/scenes/stills.tsx', 'src/Root.tsx']) assert.ok(!re(sc).test(no), no);
  }
  assert.deepEqual(lineStates(stillsView(env.root, env.id)), { 'b01-1': 'check', 'b01-2': 'check', 'b02-1': 'todo', 'b02-2': 'todo', 'b03-1': 'todo' });
});

test('a still held only by the measured checks is measured again on load and goes to the owner\'s check when they now pass', async (t) => {
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const text = (id, y) => ({ id, type: 'text', opacity: 1, bounds: { x: 50, y, width: 200, height: 40 }, text: { text: '', lines: [{}] } });
  m.config._inspectProbe = async () => ({ width: 400, height: 200, layers: [text('a', 50), text('b', 60)] });
  await runGroup(env, m);
  const doc = JSON.parse(readFileSync(join(env.work, 'design/stills/stills.json'), 'utf8'));
  assert.equal(doc.lines['b01-1'].state, 'held');
  assert.match(doc.lines['b01-1'].held[0], /^Studio check · no-collisions/);
  // the check is fixed (here: the saved inspect.json now has no overlap); the app reloads
  writeFileSync(join(env.work, 'design/stills/b01-1-v1.inspect.json'), JSON.stringify({ width: 400, height: 200, layers: [text('t', 50)] }));
  const v = stillsView(env.root, env.id);
  const line = (id) => v.lines.find((l) => l.line === id);
  assert.equal(line('b01-1').state, 'check'); assert.equal(line('b01-1').held, null); assert.deepEqual(line('b01-1').problems, []);
  // still failing: stays held, and the app gets the measured problems (never a ✓ over a failing check)
  assert.equal(line('b01-2').state, 'held'); assert.match(line('b01-2').problems[0], /^no-collisions/);
});

test('the stills call gets the approved frame of its scene by exact path: picture and code (61dc: it guessed relative paths and drew by eye)', async (t) => {
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const put2 = (rel, d) => { mkdirSync(join(env.work, rel, '..'), { recursive: true }); writeFileSync(join(env.work, rel), d); };
  put2('video/src/scenes/sf01.tsx', 'export const SF01 = () => null;');
  put2('video/src/scenes/sf02.tsx', 'export const SF02 = () => null;');
  put2('out/frames/sf01-v2.png', 'x'); put2('out/frames/sf01-v1.png', 'rejected');
  const ver = (n) => ({ v: n, file: `out/frames/sf01-v${n}.png`, notes: 0 });
  put2('design/frames-state.json', JSON.stringify({ frames: [
    { id: 'sf01', label: 'SF01', beats: ['b01'], round: 1, state: 'ok', current: 2, versions: [ver(1), ver(2)], note: 'ice on ink' },
    { id: 'sf02', label: 'SF02', beats: ['b02'], round: 1, state: 'ok', current: 1, versions: [{ v: 1, file: 'out/frames/sf02-v1.png', notes: 0 }], note: 'skater' },
  ] }));
  await runGroup(env, m);
  const write = log.calls.find((c) => c.schema.startsWith('files,stills'));
  const src = join(env.work, 'video', 'src');
  assert.match(write.prompt, new RegExp(`This scene's frame[^\\n]*\\n- sf01: ice on ink\\n  Its approved picture: ${join(env.work, 'out/frames/sf01-v2.png').replace(/[.]/g, '\\.')}\\n  Its code: ${join(src, 'scenes/sf01.tsx').replace(/[.]/g, '\\.')}`));
  assert.ok(write.prompt.includes(`The look's code: ${join(src, 'video.ts')}`));
  assert.ok(write.prompt.includes(`Other frames (the look):\n- sf02: skater`));
  assert.ok(!write.prompt.includes('sf01-v1.png'), 'never the rejected version');
});

test('a still\'s Fix sends the owner\'s note words to the studio, marked as winning over the checks (61dc b03-1)', async (t) => {
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  await runGroup(env, m);
  const words = 'This drifted from the approved sf03. Rebuild the chalk half as it is there. No boxed frame, no centred title card.';
  await h.call('notes.save', { node: 'b01-2', time: 0, text: words, send: false });
  await h.call('stills.fix', { line: 'b01-2' });
  const { readdirSync } = await import('node:fs');
  const fb = readdirSync(join(env.work, 'feedback')).filter((f) => /^stills-v\d+\.json$/.test(f)).sort().at(-1);
  const overall = JSON.parse(readFileSync(join(env.work, 'feedback', fb), 'utf8')).overall;
  assert.ok(overall.includes(words), overall);
  assert.match(overall, /on still b01-2/); assert.match(overall, /win over every check/);
  log.v = 2;
  await runGroup(env, m);
  const remake = log.calls.filter((c) => /## Draw these stills again/.test(c.prompt)).at(-1);
  assert.ok(remake.prompt.includes(words)); assert.match(remake.prompt, /notes below win over every check/);
});

test('stills keep their scene\'s frame ground: no alternation in the writer, the inspector or the fixer (61dc b05-1, b08-1)', async (t) => {
  assert.match(staticStills(), /GROUNDS ON STILLS: a still keeps the ground/);
  assert.ok(!/ALTERNATE GROUNDS/.test(staticStills()), 'the alternation is for planning style frames only');
  const env = studio(t);
  const log = { calls: [], files: {}, v: 1, inspected: {} };
  const m = mocks(env.work, log);
  const text = (id, y) => ({ id, type: 'text', opacity: 1, bounds: { x: 50, y, width: 200, height: 40 }, text: { text: '', lines: [{}] } });
  let fixed = false;
  m.config._inspectProbe = async () => ({ width: 400, height: 200, layers: fixed ? [text('t', 50)] : [text('a', 50), text('b', 60)] });
  log.fix = () => { fixed = true; return { ok: true, usage: {}, structured: { files: [{ path: 'src/scenes/st_b01.tsx', content: readFileSync(join(env.work, 'video/src/scenes/st_b01.tsx'), 'utf8') }], note: 'x' } }; };
  await runGroup(env, m);
  const fix = log.calls.find((c) => c.schema === 'files,note');
  assert.match(fix.prompt, /never change a still's ground/); assert.ok(!/alternates grounds on purpose/.test(fix.prompt));
  // scene 2 is inspected against the last still of scene 1
  const h = harness(t, env.root);
  await h.call('project.open', { id: env.id });
  for (const l of ['b01-1', 'b01-2']) await h.call('stills.ok', { line: l });
  log.v = 2;
  await runGroup(env, m);
  const insp = log.calls.filter((c) => c.schema === 'sections' && /## Transition compatibility/.test(c.prompt)).at(-1);
  assert.ok(insp, 'the second still is compared with the one before');
  assert.match(insp.prompt, /GROUNDS ON STILLS/); assert.match(insp.prompt, /same ground as the still before is right within a scene/);
  assert.ok(!/ALTERNATE the full-bleed background/.test(insp.prompt));
});
