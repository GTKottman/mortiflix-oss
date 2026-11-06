// A project's pinned pipeline copy made before a step was removed (layout-frames, MOSS) is migrated when loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, projectPaths, projectPipeline } from '../src/projects.mjs';

function oldProject(t) {
  const root = tempStudio(t);
  const p = createProject(root, { pipeline: 'explainer', title: 'Old', answers: { message: 'hi' } });
  const pp = projectPaths(root, p.id);
  const f = join(pp.pipeline, 'pipeline.json');
  const def = JSON.parse(readFileSync(f, 'utf8'));
  const i = def.steps.findIndex((s) => s.key === 'style-frames');
  const voice = def.steps[i].after[0];
  def.steps.splice(i, 0, { key: 'layout-frames', name: 'Layout frames', review: 'frames', when: 'moss', work: ['stills'], after: [voice], canvas: 'layout', describe: 'old' });
  def.steps[i + 1].after = ['layout-frames'];
  def.status_lines.layout = 'Drawing the layout frames';
  writeFileSync(f, JSON.stringify(def, null, 2));
  // the old validator's "moss"/"layout" values are no longer allowed: this is the failure the service showed
  for (const d of [join(pp.pipeline, 'skills', 'moss-layout'), join(pp.work, '.claude', 'skills', 'moss-layout')]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'SKILL.md'), 'x'); }
  mkdirSync(join(pp.state, 'skills'), { recursive: true });
  writeFileSync(join(pp.state, 'skills', 'moss-layout.md'), 'x');
  mkdirSync(join(pp.reviews, 'layout-frames'), { recursive: true });
  writeFileSync(join(pp.reviews, 'layout-frames', 'v1.json'), '{}');
  return { root, id: p.id, pp, f, voice };
}

test('old project: layout-frames dropped, pointers fixed, backup + stale skills gone, reviews kept', (t) => {
  const { root, id, pp, f, voice } = oldProject(t);
  const pl = projectPipeline(root, id);
  assert.ok(!pl.steps.some((s) => s.key === 'layout-frames'));
  assert.deepEqual(pl.steps.find((s) => s.key === 'style-frames').after, [voice]);
  const disk = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(!JSON.stringify(disk).includes('layout-frames'));
  assert.equal(disk.status_lines.layout, undefined);
  const baks = readdirSync(pp.pipeline).filter((n) => n.startsWith('pipeline.json.bak-'));
  assert.equal(baks.length, 1);
  assert.ok(readFileSync(join(pp.pipeline, baks[0]), 'utf8').includes('layout-frames'));
  assert.ok(!existsSync(join(pp.pipeline, 'skills', 'moss-layout')));
  assert.ok(!existsSync(join(pp.work, '.claude', 'skills', 'moss-layout')));
  assert.ok(!existsSync(join(pp.state, 'skills', 'moss-layout.md')));
  assert.ok(existsSync(join(pp.reviews, 'layout-frames', 'v1.json')));
  // second load: nothing more happens (still one backup, same file)
  const before = readFileSync(f, 'utf8');
  projectPipeline(root, id);
  assert.equal(readFileSync(f, 'utf8'), before);
  assert.equal(readdirSync(pp.pipeline).filter((n) => n.startsWith('pipeline.json.bak-')).length, 1);
});

test('implicit "after" (no after key) is kept as a straight line when a step is dropped', (t) => {
  const { root, id, f } = oldProject(t);
  const def = JSON.parse(readFileSync(f, 'utf8'));
  for (const s of def.steps) delete s.after;
  writeFileSync(f, JSON.stringify(def));
  const pl = projectPipeline(root, id);
  const keys = def.steps.map((s) => s.key).filter((k) => k !== 'layout-frames');
  const i = keys.indexOf('style-frames');
  assert.deepEqual(pl.steps.find((s) => s.key === 'style-frames').after, [keys[i - 1]]);
});

test('an unknown/invalid step is skipped, not fatal for the project', (t) => {
  const { root, id, pp } = oldProject(t);
  projectPipeline(root, id); // migrate first
  const f = join(pp.pipeline, 'pipeline.json');
  const def = JSON.parse(readFileSync(f, 'utf8'));
  def.steps.push({ key: 'weird', review: 'frames', when: 'nonsense', after: ['script'] });
  writeFileSync(f, JSON.stringify(def));
  const pl = projectPipeline(root, id);
  assert.ok(!pl.steps.some((s) => s.key === 'weird'));
  assert.ok(pl.steps.some((s) => s.key === 'style-frames'));
});
