import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createService } from '../src/service.mjs';
import { createProject, loadProject, projectPaths, update } from '../src/projects.mjs';
import { writeJson } from '../src/studio.mjs';

function harness(t, root) {
  const out = [];
  const svc = createService({ root, send: (m) => out.push(m), runner: false, tickMs: 0 });
  t.after(() => svc.close());
  let n = 1;
  const call = async (type, params = {}) => {
    const id = n++;
    await svc.handle({ id, type, params });
    return out.find((m) => m.id === id);
  };
  return { call };
}

// A v3 project whose brief, script and voice are approved and whose style frames are in review, with the files each
// step writes in the working folder and a canvas of beats, lines and shots.
function madeProject(root) {
  const id = createProject(root, { pipeline: 'v3', title: 'Why ice is slippery', answers: { topic: 'ice' } }).id;
  const pp = projectPaths(root, id);
  const ok = (v) => ({ state: 'approved', version: v, decided_at: '2026-11-02T09:00:00.000Z' });
  update(root, id, (p) => {
    p.state = 'waiting';
    p.steps = { brief: ok(1), script: ok(2), voice: ok(1), 'style-frames': { state: 'in_review', version: 1 } };
    p.usage = { sessions: 3, cost_usd: 0.2 };
  });
  const w = (rel, text = 'x') => { mkdirSync(join(pp.work, rel, '..'), { recursive: true }); writeFileSync(join(pp.work, rel), text); };
  w('script/beats.json', '{"beats":[]}');
  w('script.md', '# Script');
  w('voice/lines.json', '[]');
  w('sound/voice/voice.wav');
  w('out/voice/a.wav');
  w('out/scenes.json', '[]');
  w('design/brief.json', '{}');
  w('design/frames.json', '[]');
  w('JOURNAL.md', 'made voice');
  w('feedback/script-v2.json', '{}');
  w('feedback/voice-v1.json', '{}');
  w('feedback/style-frames-v1.json', '{}');
  for (const k of ['brief', 'script', 'voice', 'style-frames']) { mkdirSync(join(pp.reviews, k, 'v1'), { recursive: true }); writeFileSync(join(pp.reviews, k, 'v1', 'submission.json'), '{}'); }
  writeFileSync(join(pp.state, 'brief.json'), '{"brief":{}}');
  mkdirSync(join(pp.sessions), { recursive: true });
  writeFileSync(join(pp.sessions, 's.jsonl'), '{}');
  writeFileSync(join(pp.state, 'chat.jsonl'), '{}\n');
  const canvas = join(pp.state, 'canvas');
  for (const m of ['b01-1', 's01', 'f01']) { mkdirSync(join(canvas, 'media', m), { recursive: true }); writeFileSync(join(canvas, 'media', m, 'a.bin'), 'x'); }
  writeJson(join(canvas, 'graph.json'), {
    format: 1, project: id, order: { beats: ['b01'], shots: ['s01'], lines: ['b01-1'], frames: ['f01'], cues: [], transitions: [] },
    nodes: {
      b01: { id: 'b01', kind: 'beat', versions: [{ v: 1 }] },
      s01: { id: 's01', kind: 'shot', versions: [{ v: 1, file: 'canvas/media/s01/a.bin' }], current: 1 },
      'b01-1': { id: 'b01-1', kind: 'line', versions: [{ v: 1 }] },
      f01: { id: 'f01', kind: 'frame', versions: [{ v: 1 }] },
    },
    problems: [],
  });
  writeJson(join(canvas, 'owner.json'), { decisions: { b01: { verdict: 'ok' }, 'b01-1': { verdict: 'ok' }, f01: { verdict: 'ok' } } });
  writeJson(join(pp.state, 'options.json'), { entries: { 'script|b01': { options: [] }, 'voiceMusic|b01-1': { options: [] } } });
  return id;
}

test('project.rename changes the title the list shows, refuses an empty one', async (t) => {
  const root = tempStudio(t);
  const id = madeProject(root);
  const { call } = harness(t, root);
  const r = await call('project.rename', { project: id, title: '  Ice,   really  ' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.result, { project: id, title: 'Ice, really', before: 'Why ice is slippery' });
  const list = await call('project.list');
  assert.equal(list.result.find((p) => p.id === id).title, 'Ice, really');
  assert.match(readFileSync(projectPaths(root, id).events, 'utf8'), /"RENAMED"/);
  assert.equal((await call('project.rename', { project: id, title: '   ' })).ok, false);
});

test('project.duplicate copies the brief and script only, paused, without sessions, chat or later steps', async (t) => {
  const root = tempStudio(t);
  const id = madeProject(root);
  const { call } = harness(t, root);
  const r = await call('project.duplicate', { project: id });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const nid = r.result.project;
  assert.notEqual(nid, id);
  assert.deepEqual(r.result.kept, ['brief', 'script']);
  const p = loadProject(root, nid);
  assert.equal(p.title, 'Why ice is slippery (copy)');
  assert.equal(p.state, 'paused', 'no session starts, so no paid call');
  assert.equal(p.session, null);
  assert.deepEqual(Object.keys(p.steps), ['brief', 'script']);
  assert.equal(p.usage, undefined);
  assert.equal(p.copied_from.project, id);
  const pp = projectPaths(root, nid);
  assert.ok(existsSync(join(pp.work, 'script', 'beats.json')));
  assert.ok(existsSync(join(pp.work, 'script.md')));
  assert.ok(existsSync(join(pp.work, 'design', 'brief.json')), 'the brief\'s design notes stay');
  for (const gone of ['voice', 'sound/voice', 'out', 'design/frames.json', 'JOURNAL.md', 'feedback/voice-v1.json']) assert.equal(existsSync(join(pp.work, gone)), false, gone);
  assert.ok(existsSync(join(pp.work, 'feedback', 'script-v2.json')));
  assert.ok(existsSync(join(pp.state, 'brief.json')));
  assert.deepEqual(readdirSync(pp.reviews).sort(), ['brief', 'script']);
  assert.deepEqual(readdirSync(pp.sessions), []);
  assert.equal(existsSync(join(pp.state, 'chat.jsonl')), false);
  const g = JSON.parse(readFileSync(join(pp.state, 'canvas', 'graph.json'), 'utf8'));
  assert.deepEqual(Object.keys(g.nodes).sort(), ['b01', 's01']);
  assert.deepEqual(g.nodes.s01.versions, [], 'shot videos come from the animatic');
  assert.deepEqual(g.order.lines, []);
  const owner = JSON.parse(readFileSync(join(pp.state, 'canvas', 'owner.json'), 'utf8'));
  assert.deepEqual(Object.keys(owner.decisions), ['b01']);
  assert.deepEqual(readdirSync(join(pp.state, 'canvas', 'media')), []);
  const opts = JSON.parse(readFileSync(join(pp.state, 'options.json'), 'utf8'));
  assert.deepEqual(Object.keys(opts.entries), ['script|b01']);
  // the original is untouched
  assert.ok(existsSync(join(projectPaths(root, id).work, 'voice', 'lines.json')));
  assert.equal(loadProject(root, id).title, 'Why ice is slippery');
});

test('project.duplicate upto keeps approved later steps and stops at the first one not approved', async (t) => {
  const root = tempStudio(t);
  const id = madeProject(root);
  const { call } = harness(t, root);
  const r = await call('project.duplicate', { project: id, upto: 'animatic' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.result.kept, ['brief', 'script', 'voice'], 'style frames are in review: the copy stops before them');
  const pp = projectPaths(root, r.result.project);
  for (const kept of ['voice/lines.json', 'sound/voice/voice.wav', 'out/voice/a.wav', 'feedback/voice-v1.json']) assert.ok(existsSync(join(pp.work, kept)), kept);
  assert.equal(existsSync(join(pp.work, 'out', 'scenes.json')), false);
  assert.equal(existsSync(join(pp.work, 'design', 'frames.json')), false);
  const g = JSON.parse(readFileSync(join(pp.state, 'canvas', 'graph.json'), 'utf8'));
  assert.deepEqual(Object.keys(g.nodes).sort(), ['b01', 'b01-1', 's01']);
  assert.deepEqual(readdirSync(join(pp.state, 'canvas', 'media')), ['b01-1']);
  assert.deepEqual((await call('project.duplicate', { project: id, upto: 'all' })).result.kept, ['brief', 'script', 'voice']);
  assert.equal((await call('project.duplicate', { project: id, upto: 'nope' })).ok, false);
});

test('project.delete moves both folders to the trash; project.restore brings them back; a running session refuses', async (t) => {
  const root = tempStudio(t);
  const id = madeProject(root);
  const { call } = harness(t, root);
  update(root, id, (p) => { p.session = { running: true, id: 's' }; });
  const refused = await call('project.delete', { project: id });
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /being made right now/);
  assert.ok(existsSync(projectPaths(root, id).file));
  update(root, id, (p) => { p.session = null; });

  assert.equal((await call('project.open', { id })).ok, true);
  const d = await call('project.delete', { project: id });
  assert.equal(d.ok, true, JSON.stringify(d.error));
  assert.equal(existsSync(projectPaths(root, id).state), false);
  assert.equal(existsSync(projectPaths(root, id).work), false);
  const [entry] = readdirSync(join(root, 'trash'));
  assert.match(entry, new RegExp(`^\\d{4}-\\d{2}-\\d{2}T.*-${id}$`));
  assert.ok(existsSync(join(root, 'trash', entry, 'work', 'script.md')));
  assert.equal((await call('project.list')).result.some((p) => p.id === id), false);
  assert.equal((await call('state.get')).result.project, null, 'the open project closes');

  const back = await call('project.restore', { project: id });
  assert.equal(back.ok, true, JSON.stringify(back.error));
  assert.equal(back.result.title, 'Why ice is slippery');
  assert.ok(existsSync(join(projectPaths(root, id).work, 'script.md')));
  assert.deepEqual(readdirSync(join(root, 'trash')), []);
  assert.match(readFileSync(projectPaths(root, id).events, 'utf8'), /"RESTORED"/);
  assert.equal((await call('project.restore', { project: id })).ok, false, 'not deleted');
});
