// Review size settings (owner 2026-11-01): options.count, review.framesPerRound, review.scenesPerGroup.
// settings.get / settings.set, ranges, and each setting's effect. No AI, no paid call (a stand-in claude script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { saveConfig, loadConfig, readJson, paths } from '../src/studio.mjs';
import { syncCanvas } from '../src/canvas.mjs';
import { planFrames, ensurePlan } from '../src/svc/frames.mjs';
import { stillGroups } from '../src/svc/stills.mjs';
import { reviewSettings } from '../src/svc/reviewsize.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';

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
  return { call, out };
}
async function until(fn, ms = 10_000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(25); } }
async function project(call, root) {
  const p = await call('project.new', { preset: 'explainer', title: 'Size', idea: 'x', start: false });
  const work = join(root, 'projects', p.project.id);
  mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: 'One.' }] }));
  syncCanvas(root, p.project.id);
  return p.project.id;
}

test('settings: defaults, set, persist, ranges refused', async (t) => {
  const root = tempStudio(t);
  const { call, out } = harness(t, root);
  assert.deepEqual(await call('settings.get'), { options: { count: 4 }, review: { framesPerRound: 3, scenesPerGroup: 1 } });
  assert.deepEqual(await call('settings.set', { options: { count: 6 } }), { options: { count: 6 }, review: { framesPerRound: 3, scenesPerGroup: 1 } });
  const r = await call('settings.set', { review: { scenesPerGroup: 2 } }); // a partial patch keeps the rest
  assert.deepEqual(r, { options: { count: 6 }, review: { framesPerRound: 3, scenesPerGroup: 2 } });
  assert.ok(out.some((m) => m.event === 'settings.changed'));
  assert.deepEqual(loadConfig(root).review, { framesPerRound: 3, scenesPerGroup: 2 }); // lives in config.json
  for (const bad of [{ options: { count: 0 } }, { options: { count: 9 } }, { options: { count: 2.5 } }, { options: { count: '3' } }, { review: { framesPerRound: 7 } }, { review: { framesPerRound: 0 } }, { review: { scenesPerGroup: 'all' } }, { review: { scenesPerGroup: 7 } }]) {
    await assert.rejects(call('settings.set', bad), /whole number from/, JSON.stringify(bad));
  }
  assert.deepEqual((await call('settings.get')).review, { framesPerRound: 3, scenesPerGroup: 2 }, 'a refused change changes nothing');
  assert.deepEqual(reviewSettings({ options: { count: 99 }, review: { framesPerRound: 'x' } }), { options: { count: 4 }, review: { framesPerRound: 3, scenesPerGroup: 1 } }); // hand-edited junk -> defaults
});

test('options.count: defaults and the stand-in Claude are cut to the count, and Claude is asked for that many', async (t) => {
  const root = tempStudio(t);
  const bin = join(root, 'fake-claude'); const seen = join(root, 'prompt.txt');
  writeFileSync(bin, `#!/bin/sh
case "$1" in
  -p) case "$2" in *"option buttons"*) printf '%s' "$2" > "${seen}";; *) echo '{"type":"result","is_error":false,"result":"{}"}'; exit 0;; esac
      echo '{"type":"result","is_error":false,"result":"{\\"options\\": [{\\"label\\": \\"A\\", \\"text\\": \\"Do a.\\", \\"nodes\\": []}, {\\"label\\": \\"B\\", \\"text\\": \\"Do b.\\", \\"nodes\\": []}, {\\"label\\": \\"C\\", \\"text\\": \\"Do c.\\", \\"nodes\\": []}]}"}';;
esac
`);
  chmodSync(bin, 0o755);
  saveConfig(root, { backend: 'demo' });
  const { call, out } = harness(t, root);
  await project(call, root);
  await call('settings.set', { options: { count: 4 } });
  assert.equal((await call('options.get', { stage: 'script' })).options.length, 3); // default 4: all 3 defaults
  await call('settings.set', { options: { count: 2 } });
  const two = await call('options.get', { stage: 'script' });
  assert.deepEqual(two.options.map((o) => o.label), ['Shorter', 'Stronger hook']);
  await call('settings.set', { options: { count: 1 } });
  assert.equal((await call('options.get', { stage: 'script' })).options.length, 1);
  // Claude-made
  saveConfig(root, { backend: 'claude-code', claudeBin: bin, chatBackend: 'claude-code' });
  await call('settings.set', { options: { count: 2 } });
  const first = await call('options.get', { stage: 'script', target: 'b01' });
  assert.equal(first.pending, true);
  await until(() => existsSync(seen));
  assert.match(readFileSync(seen, 'utf8'), /Give up to 2 options/);
  await until(async () => (await call('options.get', { stage: 'script', target: 'b01' })).source === 'cache');
  const ai = await call('options.get', { stage: 'script', target: 'b01' });
  assert.deepEqual(ai.options.map((o) => o.label), ['A', 'B']); // 3 made, 2 kept
  await call('settings.set', { options: { count: 3 } }); // another count = another state token: made again, not served from the old cache
  assert.equal((await call('options.get', { stage: 'script', target: 'b01' })).source, 'defaults');
  await until(() => out.filter((m) => m.event === 'options.ready').length >= 2); // let the background call finish before the test ends
});

test('review.framesPerRound: the plan makes rounds of that size', () => {
  const sc = (n) => Array.from({ length: n }, (_, i) => ({ id: `b${String(i + 1).padStart(2, '0')}`, name: 'x', from_sec: i * 6, to_sec: i * 6 + 6 }));
  assert.deepEqual(planFrames(sc(7)).map((f) => f.round), [1, 1, 1, 2, 2, 2, 3]);
  assert.deepEqual(planFrames(sc(7), { perRound: 2 }).map((f) => f.round), [1, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual(planFrames(sc(7), { perRound: 6 }).map((f) => f.round), [1, 1, 1, 1, 1, 1, 2]);
  assert.deepEqual(planFrames(sc(3), { perRound: 1 }).map((f) => f.round), [1, 2, 3]);
});

test('review.scenesPerGroup: a group is that many scenes; the last OK of the group is what opens the next', (t) => {
  const root = tempStudio(t, { backend: 'claude-code' });
  const p = createProject(root, { pipeline: 'v3', title: 'Groups', answers: { topic: 'x' } });
  const work = projectPaths(root, p.id).work;
  const put = (rel, d) => { mkdirSync(join(work, rel, '..'), { recursive: true }); writeFileSync(join(work, rel), JSON.stringify(d)); };
  const beats = ['b01', 'b02', 'b03', 'b04', 'b05'];
  put('script/beats.json', { beats: beats.map((b, i) => ({ id: b, name: `Part ${i + 1}` })) });
  put('voice/lines.json', beats.flatMap((b) => [1, 2].map((k) => ({ id: `${b}-${k}`, text: `Words ${b} ${k}.` }))));
  const g1 = stillGroups(root, p.id);
  assert.equal(g1.length, 5); assert.deepEqual(g1[0].beats, ['b01']); // default 1 scene per group
  saveConfig(root, { review: { scenesPerGroup: 2 } });
  const g2 = stillGroups(root, p.id);
  assert.deepEqual(g2.map((g) => g.beats), [['b01', 'b02'], ['b03', 'b04'], ['b05']]);
  assert.deepEqual(g2[0].lines, ['b01-1', 'b01-2', 'b02-1', 'b02-2']);
  assert.deepEqual(g2.map((g) => [g.index, g.count]), [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(g2.map((g) => g.state), ['waiting', 'waiting', 'waiting'].map((x, i) => (i === 0 ? 'making' : x))); // only the first group is current
  assert.equal(stillGroups(root, p.id, { perGroup: 6 }).length, 1);
});
