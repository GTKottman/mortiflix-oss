import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  duplicateChoices,
  projectFolder,
  projectLink,
  projectParams,
  reachedStages,
  runActions,
} from '../src/screens/home/menu';
import type { HomeProject } from '../src/screens/home/types';

const project = (over: Partial<HomeProject>): HomeProject => ({
  id: '261102-ice-ab12',
  title: 'Why ice is slippery',
  stage: 0,
  pipeline: { stage_set: 'v3' },
  ...over,
});

describe("a project's ⋯ menu", () => {
  it('opens a project at any stage it reached, its own last', () => {
    expect(reachedStages(project({ stage: 0 }))).toEqual(['script']);
    expect(reachedStages(project({ delivered: true, state: 'delivered' }))).toEqual([
      'script',
      'voice',
      'look',
      'stills',
      'motion',
      'sound',
      'finish',
    ]);
  });

  it('pauses while it works, resumes once paused, never stops a finished one', () => {
    expect(runActions(project({ state: 'queued' }))).toEqual(['pause', 'stop']);
    expect(runActions(project({ state: 'paused' }))).toEqual(['resume', 'stop']);
    expect(runActions(project({ state: 'waiting' }))).toEqual(['stop']);
    expect(runActions(project({ state: 'draft' }))).toEqual([]);
    expect(runActions(project({ delivered: true, state: 'delivered' }))).toEqual([]);
    expect(runActions(project({ state: 'cancelled' }))).toEqual(['resume']);
  });

  it('copies a whole address', () => {
    expect(projectLink('http://127.0.0.1:4646/app/#/', '/app/?project=p#/script')).toBe(
      'http://127.0.0.1:4646/app/?project=p#/script',
    );
  });

  it('names the project as `project` in every call (the service reads that, not `id`)', () => {
    expect(projectParams(project({}))).toEqual({ project: '261102-ice-ab12' });
  });

  it('duplicates the brief and script, and every OK’d step once a later one is OK’d', () => {
    expect(duplicateChoices(project({ stage: 0 }))).toEqual([{ label: 'Duplicate' }]);
    expect(duplicateChoices(project({ delivered: true, state: 'delivered' }))).toEqual([
      { label: 'Duplicate' },
      { label: 'Duplicate with every OK’d step', upto: 'all' },
    ]);
  });

  it('opens the working folder and tidies a typed name', () => {
    expect(projectFolder(project({}))).toBe('projects/261102-ice-ab12');
    expect(cleanTitle('  Ice,   really \n')).toBe('Ice, really');
    expect(cleanTitle('   ')).toBe('');
    expect(cleanTitle('x'.repeat(200))).toHaveLength(120);
  });
});
