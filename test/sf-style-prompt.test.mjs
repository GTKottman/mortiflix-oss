// Style frames v3, version 2: the frame writer's prompt carries the pack's colour jobs and rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject } from '../src/projects.mjs';
import { setBrief } from '../src/svc/lookbrief.mjs';
import { styleText } from '../src/svc/packs.mjs';
import { writePrompt, context } from '../src/quickframes.mjs';

test('the write prompt names every colour with its job and rule, and the type and shapes', (t) => {
  const root = tempStudio(t);
  mkdirSync(join(root, 'packs/style/aig'), { recursive: true });
  writeFileSync(join(root, 'packs/style/aig/pack.json'), JSON.stringify({ kind: 'style', name: 'Aig', fonts: ['Urbanist'], palette: ['#fafafa', '#fd3a25'],
    style: { palette: [{ hex: '#fafafa', job: 'ground', rule: 'main background' }, { hex: '#fd3a25', job: 'accent', rule: 'only on buttons, tags and one highlighted word' }],
      type: { heading: { font: 'Urbanist', weight: 700, case: 'sentence', shape: 'bold geometric' } }, shapes: { corners: 'slightly rounded' }, mood: 'Confident' } }));
  const p = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x' } });
  setBrief(root, p.id, { pack: 'aig' });
  const text = writePrompt(root, p.id, context(root, p.id));
  assert.match(text, /#fd3a25 · accent: only on buttons, tags and one highlighted word/);
  assert.match(text, /heading: Urbanist, 700, sentence case, bold geometric/);
  assert.match(text, /corners: slightly rounded/);
  assert.equal(styleText(null), '');
});
