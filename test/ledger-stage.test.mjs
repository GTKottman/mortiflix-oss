// Dir3 61dc (2026-11-02): 111 Claude rows booked to "artcraft" from 09:10, long before Finish: with nothing being made,
// the ledger took the last step. Now: a waiting canvas edit books to its piece's stage, else the step being made, else
// the step in review, else the first step not finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempStudio } from './helpers.mjs';
import { createProject, startProject, projectPaths, update } from '../src/projects.mjs';
import { currentStage } from '../src/svc/ledger.mjs';

function v3(t) {
  const root = tempStudio(t, { backend: 'claude-code' });
  const p = createProject(root, { pipeline: 'v3', title: 'Ice', answers: { topic: 'Ice', voice: 'Pick in the script step' } });
  startProject(root, p.id);
  return { root, id: p.id };
}
const steps = (root, id, s) => update(root, id, (x) => { x.steps = s; x.state = 'waiting'; });
const edits = (root, id, list) => { const d = join(projectPaths(root, id).state, 'canvas'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'edits.json'), JSON.stringify({ edits: list })); };

test('the script in review: quick calls and sessions book to script, never artcraft', (t) => {
  const { root, id } = v3(t);
  steps(root, id, { brief: { state: 'approved', version: 1 }, script: { state: 'in_review', version: 2 } });
  assert.equal(currentStage(root, id), 'script');
});

test('a waiting canvas edit books to its piece: E001 on a beat = script, E014 on a shot = motion', (t) => {
  const { root, id } = v3(t);
  steps(root, id, { brief: { state: 'approved', version: 1 }, script: { state: 'approved', version: 2 }, voice: { state: 'in_review', version: 1 } });
  assert.equal(currentStage(root, id), 'voiceMusic');
  edits(root, id, [{ id: 'E001', node: 'b03', kind: 'beat', state: 'requested' }]);
  assert.equal(currentStage(root, id), 'script');
  edits(root, id, [{ id: 'E001', node: 'b03', kind: 'beat', state: 'done' }, { id: 'E014', node: 's07', kind: 'shot', state: 'working' }]);
  assert.equal(currentStage(root, id), 'motion');
});

test('every step so far approved and the next not started: the first step not finished, not the last', (t) => {
  const { root, id } = v3(t);
  steps(root, id, { brief: { state: 'approved', version: 1 }, script: { state: 'approved', version: 2 }, voice: { state: 'approved', version: 1 }, 'style-frames': { state: 'approved', version: 7 } });
  assert.notEqual(currentStage(root, id), 'artcraft');
});
