// Packs picked in the New project window: they fill the picks their steps would ask for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths, projectPipeline, loadProject, update } from '../src/projects.mjs';
import { stepView } from '../src/gates.mjs';
import { cleanPacks, setProjectPacks, packsBriefText } from '../src/svc/projectpacks.mjs';

const write = (dir, rel, data) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), typeof data === 'string' ? data : JSON.stringify(data)); };

function studio(t) {
  const root = tempStudio(t);
  write(root, 'packs/style/most/pack.json', { format: 'mortiflix.pack', version: 1, kind: 'style', name: 'Most', description: 'Creative agency look.',
    fonts: ['Plus Jakarta Sans', 'Manrope'], palette: ['#1c1c1c', '#ffffff', '#ef5d39'], vibe: 'Bold, Creative', look: 'Dark editorial', words: 'Heavy uppercase headlines, white on charcoal.' });
  write(root, 'packs/style/most/preview-1.png', 'png');
  write(root, 'packs/scoring/lofi/pack.json', { kind: 'scoring', name: 'Lo-fi', words: 'dusty drums, warm keys' });
  write(root, 'packs/sfx/clicks/pack.json', { kind: 'sfx', name: 'Clicks' });
  return root;
}

test('packs: unknown ids are refused, nothing picked is fine', (t) => {
  const root = studio(t);
  assert.deepEqual(cleanPacks(root, undefined), {});
  assert.throws(() => cleanPacks(root, { style: 'nope' }), /no style pack "nope"/);
  assert.equal(cleanPacks(root, { style: 'most', sfx: '' }).style.name, 'Most');
});

test('packs: a style pack picked at the start is the look, so the style frames never stop to ask', async (t) => {
  const root = studio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Bikes', answers: { topic: 'bike lanes' } });
  setProjectPacks(root, p.id, cleanPacks(root, { style: 'most', scoring: 'lofi', sfx: 'clicks' }));
  const project = loadProject(root, p.id);
  assert.deepEqual(project.mfx.packs, { style: { id: 'most', name: 'Most' }, scoring: { id: 'lofi', name: 'Lo-fi' }, sfx: { id: 'clicks', name: 'Clicks' } });
  assert.equal(project.mfx.look_brief.pack, 'most');
  const brief = JSON.parse(readFileSync(join(projectPaths(root, p.id).work, 'design', 'look-brief.json'), 'utf8'));
  assert.deepEqual(brief.pack_files.palette, ['#1c1c1c', '#ffffff', '#ef5d39']);
  update(root, p.id, (x) => { for (const k of ['brief', 'script', 'voice']) x.steps[k] = { state: 'approved', version: 1 }; });
  assert.equal(stepView(loadProject(root, p.id), projectPipeline(root, p.id)).find((s) => s.key === 'style-frames').state, 'ready');
  assert.match(packsBriefText(root, p.id), /Scoring pack "Lo-fi": dusty drums, warm keys/);
  // the scoring pack picked at the start is the music step's (music/theme.json)
  assert.equal((await import('../src/svc/theme.mjs')).loadTheme(root, p.id).scoring_pack, 'lofi');
});
