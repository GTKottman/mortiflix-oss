// Beat names (owner's first run: "Look up! On a…" cut off): the script's own name, else the AI's, else a title from
// the words, on the nodes, the Script panel and Mortiflix Studio's bins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject } from '../src/projects.mjs';
import { saveConfig, loadConfig } from '../src/studio.mjs';
import { shortTitle, beatNames, nameBeats, unnamed } from '../src/svc/beatnames.mjs';
import { readBeats } from '../src/canvas.mjs';
import { graphView, handoffPlan } from '../src/svc/graph.mjs';
import { scriptView } from '../src/svc/script.mjs';

test('beat names: a sensible title from the words, never cut off mid-phrase', () => {
  assert.equal(shortTitle('Look up! On a sunny day, the sky is bright blue. But why?'), 'The sky is bright blue');
  assert.equal(shortTitle('When sunlight reaches Earth, it zooms into the air.'), 'Sunlight reaches Earth');
  assert.equal(shortTitle('But blue light bounces the most! Its waves are short.'), 'Blue light bounces the most');
  assert.equal(shortTitle('Remember: sunlight bounces off the air. Blue bounces the most.'), 'Sunlight bounces off the air');
  assert.equal(shortTitle('Boing!'), 'Boing');
  for (const w of ['Open on a single shape that becomes the logo.', 'A b c d e f g of the', 'x']) assert.ok(!/ (a|the|of|on)$/i.test(shortTitle(w)), w);
});

test('beat names: the script\'s own name first, then the AI\'s (asked once per words), then the words', async (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Names', answers: { topic: 'x' } });
  const work = join(root, 'projects', p.id);
  mkdirSync(join(work, 'script'), { recursive: true });
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [
    { id: 'b01', words: 'Look up! On a sunny day, the sky is bright blue. But why?', name: 'Why is it blue?' },
    { id: 'b02', words: 'Sunlight looks white, but it is every colour of the rainbow.' },
    { id: 'b03', words: 'Sunset bonus! When the sun is low, the blue bounces away.' },
  ] }));
  const beats = readBeats(work, []);
  assert.equal(beats[0].name, 'Why is it blue?');
  assert.deepEqual(Object.values(beatNames(root, p.id, beats)).map((n) => n.from), ['script', 'words', 'words']);
  assert.deepEqual(unnamed(root, p.id).map((b) => b.id), ['b02', 'b03']);
  // A real backend asks the user's own AI once for every beat without a name.
  saveConfig(root, { ...loadConfig(root), backend: 'claude-code' });
  const asked = [];
  const r = await nameBeats(root, p.id, { ask: async (prompt) => { asked.push(prompt); return 'Here: {"names": {"b02": "Sunlight is every colour", "b03": "Sunset bonus"}}'; } });
  assert.deepEqual(r.named, ['b02', 'b03']);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /b02: Sunlight looks white/);
  assert.deepEqual(unnamed(root, p.id), []);
  await nameBeats(root, p.id, { ask: async () => assert.fail('asked twice for the same words') });
  const g = graphView(root, p.id);
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'beat').map((n) => n.name), ['Why is it blue?', 'Sunlight is every colour', 'Sunset bonus']);
  assert.deepEqual(g.beats.map((b) => b.name), ['Why is it blue?', 'Sunlight is every colour', 'Sunset bonus']);
  assert.deepEqual(scriptView(root, p.id).beats.map((b) => b.name), ['Why is it blue?', 'Sunlight is every colour', 'Sunset bonus']);
  assert.ok(handoffPlan(root, p.id).markers.every((m) => m.kind !== 'chapter' || !/On a sunny/.test(m.name)));
  // New words: named again.
  writeFileSync(join(work, 'script', 'beats.json'), JSON.stringify({ beats: [{ id: 'b01', words: 'Look up!', name: 'Why is it blue?' }, { id: 'b02', words: 'Light is a rainbow.' }, { id: 'b03', words: 'Sunset bonus! When the sun is low, the blue bounces away.' }] }));
  assert.deepEqual(unnamed(root, p.id).map((b) => b.id), ['b02']);
});
