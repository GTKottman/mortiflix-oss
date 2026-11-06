// The stage's ⋯ (StageMenu): reopen an OK'd step (stage.reopen) or make the step in review again (review.respond
// changes), and "Edit the brief…" where the stage has one. A failed still offers Draw again (stills.fix).
import { describe, expect, it } from 'vitest';
import { GO_BACK_LABEL, goBackOf, isPaidStep, stageActions, stagePanel } from '../src/lib/stage-tools.svelte';
import { stageById } from '../src/lib/stages';
import type { StageStatus } from '../src/lib/service/types';

const look = stageById('look');
const status = (states: string[]): StageStatus[] => [
  { key: 'look', steps: states.map((state, i) => ({ key: `s${i}`, name: `Step ${i}`, state })) },
];

describe('going back on a stage', () => {
  it('reopens the last OK’d step', () => {
    expect(goBackOf(look, status(['approved', 'done']))).toMatchObject({
      kind: 'reopen',
      key: 'look',
      step: { key: 's1' },
    });
  });

  it('makes the step in review again when nothing is OK’d', () => {
    expect(goBackOf(look, status(['in_review']))).toMatchObject({ kind: 'remake', step: { key: 's0' } });
  });

  it('offers nothing while nothing is made', () => {
    expect(goBackOf(look, status(['working']))).toBeNull();
    expect(goBackOf(look, [])).toBeNull();
  });

  it('lists the brief and a greyed reopen with its reason', () => {
    const actions = stageActions('look', true, []);
    expect(actions.map((a) => a.label)).toEqual(['Edit the brief…', GO_BACK_LABEL.reopen]);
    expect(actions[1]?.why).toBeTruthy();
    actions[0]?.run();
    expect(stagePanel.on('look')).toEqual({ kind: 'brief', stage: 'look' });
    expect(stagePanel.on('motion')).toBeNull();
    stagePanel.close();
  });

  it('knows the paid steps', () => {
    expect(isPaidStep('voice')).toBe(true);
    expect(isPaidStep('stills')).toBe(false);
  });
});
