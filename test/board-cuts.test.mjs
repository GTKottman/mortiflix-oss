// A transition board written between style frames (owner's first run: "SF01 · Opening" → "SF02 · …", lands on B03)
// sits on its cut in the film, with its name and picture, instead of every cut saying "Pick one".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject } from '../src/projects.mjs';
import { syncCanvas } from '../src/canvas.mjs';
import { graphView } from '../src/svc/graph.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');

test('board transitions sit on their cuts: shot ids, the beat they land on, or the frames on either side', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Board', answers: { topic: 'x' } });
  const work = join(root, 'projects', p.id);
  for (const d of ['script', 'design', 'transitions', 'out/frames', 'out/board']) mkdirSync(join(work, d), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: ['One.', 'Two.', 'Three.', 'Four.', 'Five.'].map((w, i) => ({ id: `b0${i + 1}`, words: w })) }));
  for (const f of ['sf01', 'sf02', 'sf03']) writeFileSync(join(work, 'out', 'frames', `${f}.png`), PNG);
  writeFileSync(join(work, 'design', 'frames.json'), JSON.stringify({ frames: [
    { id: 'sf01', file: 'out/frames/sf01.png', label: 'SF01 · Opening', beats: ['b01'] },
    { id: 'sf02', file: 'out/frames/sf02.png', label: 'SF02 · Blue bounces', beats: ['b03', 'b04'] },
    { id: 'sf03', file: 'out/frames/sf03.png', label: 'SF03 · End card', beats: ['b05'] },
  ] }));
  writeFileSync(join(work, 'out', 'board', 'cut-01.png'), PNG);
  writeFileSync(join(work, 'transitions', 'board.json'), JSON.stringify({ cuts: [
    { from: 'SF01 · Opening', to: 'SF02 · Blue bounces', transition: 'portal-zoom', lands_on: '"air" in B03 ("it zooms into the air")' },
    { from: 'SF02 · Blue bounces', to: 'SF03 · End card', transition: { new: 'card-carry', inspired_by: ['dot-led'] } },
    { from_scene: 's01', to_scene: 's02', transition: 'Crossfade' },
    { from: 'somewhere', to: 'elsewhere', transition: 'wipe' },
  ] }));
  syncCanvas(root, p.id);
  const g = graphView(root, p.id);
  const tr = Object.fromEntries(g.nodes.filter((n) => n.kind === 'transition').map((n) => [n.id, n]));
  assert.deepEqual([tr.t01.from, tr.t01.to, tr.t01.title], ['s02', 's03', 'portal zoom']);
  assert.ok(tr.t01.versions.at(-1).path?.endsWith('.png'), 'the board picture is its media');
  assert.deepEqual([tr.t02.from, tr.t02.to, tr.t02.title], ['s04', 's05', 'card carry']);
  assert.deepEqual([tr.t03.from, tr.t03.to], ['s01', 's02']);
  assert.deepEqual([tr.t04.from, tr.t04.to], [null, null]);
  const next = g.edges.filter((e) => e.kind === 'next').map((e) => `${e.from}>${e.to}`);
  for (const e of ['s02>t01', 't01>s03', 's04>t02', 't02>s05', 's01>t03', 't03>s02']) assert.ok(next.includes(e), e);
});

test('an OK is only on a made piece: a planned shot refuses it and never counts as OK', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Plans', answers: { topic: 'x' } });
  const work = join(root, 'projects', p.id);
  mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: 'One.' }] }));
  const { nodeAction, canvasView } = await import('../src/canvas.mjs');
  syncCanvas(root, p.id);
  assert.throws(() => nodeAction(root, p.id, 's01', { action: 'ok' }), /S01 isn't made yet/);
  assert.equal(canvasView(root, p.id).nodes.s01.state, 'generating');
  assert.ok(nodeAction(root, p.id, 's01', { action: 'fix', text: 'make it bluer' }).edit, 'a Fix on the plan still works');
});
