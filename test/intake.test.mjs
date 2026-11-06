// The owner can always answer a choice in their own words (the Custom option), unless the pipeline says otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject } from '../src/projects.mjs';
import { paths, REPO } from '../src/studio.mjs';

test('intake: a choice takes a custom answer; "custom": false and empty or huge answers are refused', (t) => {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Custom', answers: { topic: 'x', length: '75 s', aspect: '4:5' } });
  assert.equal(p.intake.answers.length, '75 s');
  assert.equal(p.intake.answers.aspect, '4:5');
  assert.throws(() => createProject(root, { pipeline: 'explainer', title: 'Huge', answers: { topic: 'x', length: 'x'.repeat(501) } }), /your own words/);
  const pl = JSON.parse(readFileSync(join(REPO, 'pipelines', 'explainer', 'pipeline.json'), 'utf8'));
  pl.slug = 'fixed-explainer';
  pl.intake.find((q) => q.id === 'length').custom = false;
  mkdirSync(join(paths(root).root, 'pipelines', 'fixed-explainer'), { recursive: true });
  writeFileSync(join(paths(root).root, 'pipelines', 'fixed-explainer', 'pipeline.json'), JSON.stringify(pl));
  for (const f of ['PIPELINE.md', 'checklist.md']) writeFileSync(join(paths(root).root, 'pipelines', 'fixed-explainer', f), readFileSync(join(REPO, 'pipelines', 'explainer', f)));
  assert.throws(() => createProject(root, { pipeline: 'fixed-explainer', title: 'Fixed', answers: { topic: 'x', length: '75 s' } }), /must be one of: 30 s, 60 s, 90 s, 2 min$/);
});

test('presets: save your own copy with its own name and defaults; built-ins never change', async (t) => {
  const { savePreset, listPipelines, findPipeline } = await import('../src/pipelines.mjs');
  const root = tempStudio(t);
  const r = savePreset(root, 'explainer', { name: 'Short explainer', defaults: { length: '45 s', aspect: '9:16', audience: 'city councillors' } });
  assert.equal(r.slug, 'short-explainer');
  const mine = findPipeline(root, 'short-explainer');
  assert.equal(mine.source, 'studio');
  assert.equal(mine.intake.find((q) => q.id === 'length').default, '45 s');
  assert.ok(mine.intake.find((q) => q.id === 'length').choices.includes('45 s'));
  assert.equal(mine.intake.find((q) => q.id === 'audience').default, 'city councillors');
  assert.equal(findPipeline(root, 'explainer').intake.find((q) => q.id === 'length').default, '60 s');
  assert.throws(() => savePreset(root, 'explainer', { name: 'Short explainer' }), /already have a preset/);
  savePreset(root, 'short-explainer', { name: 'Short explainer', defaults: { length: '30 s' } });
  assert.equal(findPipeline(root, 'short-explainer').intake.find((q) => q.id === 'length').default, '30 s');
  assert.throws(() => savePreset(root, 'explainer', { name: 'Explainer' }), /built-in/);
  const p = createProject(root, { pipeline: 'short-explainer', title: 'From my preset', answers: { topic: 'x', length: '30 s' } });
  assert.equal(p.pipeline.slug, 'short-explainer');
  assert.ok(listPipelines(root).some((x) => x.slug === 'short-explainer' && !x.error));
});

test('project ids and file names keep accented words whole (ö→o, ß→ss), no hyphen inside a word', async () => {
  const { newId, safeName } = await import('../src/projects.mjs');
  assert.match(newId('Gödel, Escher, Bach: An Eternal Golden Braid'), /^\d{6}-godel-escher-bach-an-eternal-gol-\w{4}$/);
  assert.match(newId('Straße Café Ærø'), /^\d{6}-strasse-cafe-aero-\w{4}$/);
  assert.equal(safeName('Gödel Pörträt.png'), 'Godel-Portrat.png');
});
