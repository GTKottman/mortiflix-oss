// Fixes found while merging the Mortiflix Studio parts: a missing BPM stays missing, ComfyUI counts as installed
// only when it is the studio's own, handoff.plan names the .mortiflix, asset nodes keep their place, shot versions get a
// PNG still.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cleanTheme } from '../src/svc/theme.mjs';
import { makeHandoffDemo } from '../src/demo-handoff.mjs';
import { handoffPlan, graphView, moveNodes, stillsSettled, spoken, shotTimeline } from '../src/svc/graph.mjs';
import { setupStatus, TOOLS, PARTS } from '../src/setup.mjs';
import { saveConfig } from '../src/studio.mjs';
import { update } from '../src/projects.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('a music theme without a BPM keeps it missing (null, empty and false are not 30)', () => {
  const t = cleanTheme({ tempo: { feel: 'slow', bpm_min: null, bpm_max: '', bpm_fixed: 0 } });
  assert.equal(t.tempo.bpm_min, null);
  assert.equal(t.tempo.bpm_max, null);
  assert.equal(t.tempo.bpm_fixed, undefined);
  assert.equal(cleanTheme({ tempo: { bpm_min: false } }).tempo.bpm_min, null);
  assert.equal(cleanTheme({ tempo: { bpm_min: 10, bpm_max: '96' } }).tempo.bpm_min, 30);
  assert.equal(cleanTheme({ tempo: { bpm_min: 10, bpm_max: '96' } }).tempo.bpm_max, 96);
});

test('setup no longer reports or offers the local voice or ComfyUI', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mfx-nolocal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const st = await setupStatus(root);
  for (const k of ['qwen-tts', 'comfyui', 'gpu']) assert.equal(st[k], undefined, k);
  assert.ok(!TOOLS.some((x) => ['qwen-tts', 'comfyui'].includes(x)));
  assert.doesNotMatch(PARTS.find((p) => p.id === 'narration').needs, /Qwen|ComfyUI/);
});

test('handoff.plan names the .mortiflix beside the project record; asset nodes keep their place', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mfx-fix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = makeHandoffDemo(root);
  const plan = handoffPlan(root, p.id);
  assert.match(plan.fcproj, /[/\\]state[/\\][a-z0-9-]+[/\\]edit[/\\][^/\\]+\.mortiflix$/);
  // an asset id is known to node.move; graph.get sends its pos back
  update(root, p.id, (project) => { project.assets = [...(project.assets || []), { id: 'a01', name: 'logo.png', kind: 'logo', file: 'assets/logo.png', use: 'fits', where: null, note: '', versions: [], used_in: [] }]; });
  const r = moveNodes(root, p.id, { a01: [120, -40] });
  assert.equal(r.moved, 1);
  const a = graphView(root, p.id).assets.find((x) => x.id === 'a01');
  assert.ok(a, 'the asset is in graph.get');
  assert.deepEqual(a.pos, [120, -40]);
});

test('run 2: captions and voice clip names leave out the voice directions; Edit gets the newest 3 older versions of a piece', (t) => {
  assert.equal(spoken('[curious, warm, a little smile] Ever wondered how bees make honey?'), 'Ever wondered how bees make honey?');
  assert.equal(spoken('Then they cap [beat] each cell.'), 'Then they cap each cell.');
  assert.equal(spoken('No directions.'), 'No directions.');
  const root = mkdtempSync(join(tmpdir(), 'mfx-fix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = makeHandoffDemo(root);
  const plan = handoffPlan(root, p.id);
  const per = {};
  for (const o of plan.older_versions) per[o.node] = (per[o.node] || 0) + 1;
  assert.ok(Object.values(per).every((n) => n <= 3), JSON.stringify(per));
  assert.ok(plan.captions.every((c) => !/\[/.test(c.text)));
});

test('run 2: shots cut from one animatic with overlapping ranges keep its timing (each plays until the next starts)', () => {
  const shot = (id, from, to, path = '/x/animatic.mp4') => ({ id, kind: 'shot', label: id.toUpperCase(), plays: 1, state: 'ready', versions: [{ v: 1, path, from_sec: from, to_sec: to }] });
  const gv = { order: { film: ['s01', 's02', 's03', 's04'] }, nodes: [shot('s01', 0, 4.4), shot('s02', 3, 9.03), shot('s03', 0, 4.4, '/x/s03.mp4'), shot('s04', 12.2, 16.2)] };
  const { shots, length_sec } = shotTimeline(null, null, gv);
  assert.deepEqual(shots.map((x) => [x.node, x.start_sec, x.dur_sec]), [['s01', 0, 3], ['s02', 3, 6.03], ['s03', 9.03, 4.4], ['s04', 13.43, 4]]);
  assert.equal(shots[0].media.to_sec, 3);
  assert.equal(length_sec, 17.43);
  // with their places in the animatic, a shot remade alone into a longer file plays only until the next one's place
  const at = (n, a) => ({ ...n, at_sec: a });
  const gv2 = { order: { film: ['s01', 's02', 's03'] }, nodes: [at(shot('s01', 0, 4.4), 0), at(shot('s02', 0, 5.7, '/x/s02.mp4'), 3), at(shot('s03', 8.5, 12.9), 8.5)] };
  const t2 = shotTimeline(null, null, gv2);
  assert.deepEqual(t2.shots.map((x) => [x.node, x.start_sec, x.dur_sec]), [['s01', 0, 3], ['s02', 3, 5.5], ['s03', 8.5, 4.4]]);
});

test('every shot version gets a PNG still (its first frame)', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mfx-still-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = makeHandoffDemo(root);
  graphView(root, p.id); // queues the stills
  await stillsSettled();
  const shots = graphView(root, p.id).nodes.filter((n) => n.kind === 'shot');
  const versions = shots.flatMap((n) => n.versions.filter((v) => v.path));
  assert.ok(versions.length > 0);
  for (const v of versions) {
    assert.ok(v.still, `no still for ${v.path}`);
    assert.ok(existsSync(v.still));
    assert.match(v.still, /\.png$/);
  }
});

test('chat.answer changes a question that went on with its default (the defaults card)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mfx-answer-'));
  const out = [];
  const { createService } = await import('../src/service.mjs');
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => { svc.close(); rmSync(root, { recursive: true, force: true }); });
  const p = makeHandoffDemo(root);
  const dir = join(root, 'state', p.id, 'reviews', 'brief', 'v1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'submission.json'), JSON.stringify({ step: 'brief', version: 1, submitted_at: new Date().toISOString(),
    questions: [{ id: 'pace', text: 'Should it feel calm or energetic?', choices: ['Calm', 'Energetic'], default: 'Energetic' }] }));
  let n = 1;
  const call = async (type, params = {}) => { const id = n++; await svc.handle({ id, type, params }); return out.find((m) => m.id === id); };
  const r = await call('chat.answer', { project: p.id, question: 'pace', value: 'Calm' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.answer, 'Calm');
  const rows = (await call('chat.history', { project: p.id, limit: 10 })).result;
  const list = Array.isArray(rows) ? rows : rows.rows || rows.messages || [];
  assert.ok(list.some((m) => m.role === 'action' && /calm or energetic\? → Calm/.test(m.text)), JSON.stringify(list.slice(-3)));
  const bad = await call('chat.answer', { project: p.id, question: 'nope', value: 'x' });
  assert.equal(bad.ok, false);
});

test('captions never overlap when a voice line is moved over the next one', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mfx-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = makeHandoffDemo(root);
  const before = handoffPlan(root, p.id).captions;
  assert.ok(before.length >= 2);
  const { setMix } = await import('../src/svc/graph.mjs');
  setMix(root, p.id, before[0].node, { start_sec: before[1].start_sec - 0.3 });
  const caps = handoffPlan(root, p.id).captions;
  for (let i = 0; i + 1 < caps.length; i++) assert.ok(caps[i].end_sec <= caps[i + 1].start_sec, JSON.stringify(caps.slice(i, i + 2)));
  assert.ok(caps.every((c) => c.end_sec > c.start_sec));
});

test('run 3: a voice line becomes short one-line subtitles, each at its words, back to back', async () => {
  const { subtitles, SUB_LINE, SUB_LINES } = await import('../src/svc/graph.mjs');
  assert.equal(SUB_LINES, 1);
  const text = 'In 1979, Douglas Hofstadter wrote a whole book about loops like this one. It\'s called Gödel, Escher, Bach: an Eternal Golden Braid, and in 1980 it won the Pulitzer Prize for General Nonfiction. Let\'s go.';
  const ws = text.split(' ');
  const t = { start: 100, words: ws.map((w, i) => ({ text: w, start: 100 + i * 0.4, end: 100 + i * 0.4 + 0.3 })) };
  const l = { node: 'b01-2', words: `[warm] ${text}`, start_sec: 15, dur_sec: ws.length * 0.4 };
  const subs = subtitles(l, t);
  assert.ok(subs.length >= 4, JSON.stringify(subs));
  for (const s of subs) {
    assert.ok(!s.text.includes('\n') && s.text.length <= SUB_LINE, s.text);
    assert.ok(!/\[/.test(s.text));
  }
  assert.equal(subs[0].start_sec, 15);
  for (let i = 0; i + 1 < subs.length; i++) assert.equal(subs[i].end_sec, subs[i + 1].start_sec, 'back to back');
  assert.equal(subs.at(-1).end_sec, 15 + ws.length * 0.4);
  const second = subs[1].text.split(' ')[0];
  assert.equal(subs[1].start_sec, Math.round((15 + ws.indexOf(second) * 0.4) * 1000) / 1000, 'at its first word');
  assert.ok(subs.some((s) => s.text.endsWith("Let's go.")) && !subs.some((s) => s.text === "Let's go."), 'a two-word sentence joins its neighbour');
  assert.equal(subtitles(l, null).length, subs.length, 'no word timings: the same captions, timed by characters');
});

test('run 3: a subtitle that would cover something in the picture moves to a clear place (the top edge)', async (t) => {
  const { placeSubtitles } = await import('../src/svc/subplace.mjs');
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'mfx-sub-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const video = join(dir, 'shot.mp4');
  // dark paper, and from 2 s a bright label right where the bottom subtitle goes
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1e1a15:s=1920x1080:d=4:r=30', '-vf', "drawbox=x=760:y=1030:w=400:h=36:color=white:t=fill:enable='gte(t,2)'", '-pix_fmt', 'yuv420p', video]);
  if (r.status !== 0 || !existsSync(video)) return t.skip('no ffmpeg');
  const shots = [{ kind: 'shot', start_sec: 0, dur_sec: 4, media: { kind: 'video', path: video, from_sec: 0 } }];
  const captions = [{ node: 'b01-1', text: 'Nothing under this one.', start_sec: 0.2, end_sec: 1.8 }, { node: 'b01-1', text: 'A label under this one.', start_sec: 2.2, end_sec: 3.8 }];
  // no OCR here (no tesseract named): any ink counts
  const out = await placeSubtitles({ captions, shots, cacheDir: join(dir, 'ink'), tesseract: join(dir, 'no-tesseract') });
  assert.deepEqual([captions[0].settings, captions[1].settings], [undefined, 'line:1%']);
  assert.deepEqual([out.moved, out.clashes, out.read], [1, 0, false], 'read: false (no OCR to tell words from drawings)');
});
