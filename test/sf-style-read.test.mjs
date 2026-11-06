// Style frames v3, version 0: a style pack's `style` object (colour jobs and rules, type, shapes) is kept and reaches the look brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths } from '../src/projects.mjs';
import { listAllPacks, readStyle } from '../src/svc/packs.mjs';
import { setBrief } from '../src/svc/lookbrief.mjs';

const style = { palette: [{ hex: '#fafafa', job: 'ground', rule: 'main background' }, { hex: '#fd3a25', job: 'accent', rule: 'only on one highlighted word' }, { hex: 'bad', job: 'x', rule: 'y' }],
  type: { heading: { font: 'Urbanist', weight: 700, case: 'sentence', shape: 'bold geometric' }, body: { font: 'Roboto', weight: 400 } },
  shapes: { corners: 'slightly rounded', lines: 'hairline' }, mood: 'Confident', words: 'Red only on one word.' };

test('KINDS.style.read keeps the style object: colour jobs and rules, type, shapes, mood', (t) => {
  const root = tempStudio(t);
  mkdirSync(join(root, 'packs/style/aig'), { recursive: true });
  writeFileSync(join(root, 'packs/style/aig/pack.json'), JSON.stringify({ kind: 'style', name: 'Aig', fonts: ['Urbanist'], palette: ['#fafafa', '#fd3a25'], style }));
  const p = listAllPacks(root, 'style')[0];
  assert.equal(p.style.palette.length, 2); // the bad hex is dropped
  assert.deepEqual(p.style.palette[1], { hex: '#fd3a25', job: 'accent', rule: 'only on one highlighted word' });
  assert.equal(p.style.type.heading.font, 'Urbanist');
  assert.equal(p.style.type.body.weight, 400);
  assert.equal(p.style.shapes.corners, 'slightly rounded');
  assert.equal(p.style.mood, 'Confident');
  assert.equal(readStyle(undefined), null);
  assert.equal(readStyle({}), null);
  // the look brief the style frames read carries it
  const pr = createProject(root, { pipeline: 'explainer', title: 'T', answers: { topic: 'x' } });
  setBrief(root, pr.id, { pack: 'aig' });
  const brief = JSON.parse(readFileSync(join(projectPaths(root, pr.id).work, 'design', 'look-brief.json'), 'utf8'));
  assert.equal(brief.pack_files.style.palette[1].job, 'accent');
});
