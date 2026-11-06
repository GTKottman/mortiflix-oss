import { pageParam } from './page';
import type { NeedsYou, StageStatus } from './service/types';
import type { Caller } from './stage-tools.svelte';

// Screenshot and click-through fixtures for the stage tools, with no real project: `?stagedemo=reopen` (the stage's
// step is OK'd, so its ⋯ offers Reopen; the panel lists what is made again and asks the cost first for Sound) and
// `?stagedemo=cost` (the project waits for the owner's OK on the voice's cost: the Fix it strip). Never reaches the
// service.

export type StageDemo = 'reopen' | 'cost';

/** The demo asked for in the address (after the hash, or before it). */
export function stageDemo(): StageDemo | null {
  if (!import.meta.env.DEV) return null; // screenshot demos exist in dev builds only
  const value =
    new URLSearchParams(location.hash.split('?')[1] ?? '').get('stagedemo') ?? pageParam('stagedemo');
  return value === 'reopen' || value === 'cost' ? value : null;
}

const done = (key: string, name: string): StageStatus => ({
  key,
  steps: [{ key, name, state: 'approved', version: 1 }],
});

/** Every stage OK'd up to Sound. */
export const DEMO_STATUSES: StageStatus[] = [
  done('script', 'Script'),
  done('voice', 'Voice & music'),
  done('look', 'Style frames'),
  done('stills', 'Stills'),
  done('animatic', 'Motion'),
  done('sound', 'Sound'),
];

/** The real statuses, or the demo's when `?stagedemo=reopen`. */
export const demoStatuses = (real: readonly StageStatus[]): readonly StageStatus[] =>
  stageDemo() === 'reopen' ? DEMO_STATUSES : real;

export const DEMO_NEED: NeedsYou = {
  kind: 'cost_ok',
  cause: 'cost_ok',
  step: 'voice',
  estimate_credits: 493,
  text: 'Waiting for your OK on the cost',
};

/** What the Reopen panel reads: what is made again, and Sound's cost (ask first off, so the confirm shows). */
export const demoCaller: Caller = {
  call<T>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    if (type === 'stage.remakes')
      return Promise.resolve({
        remade: [
          { step: 'stills', name: 'Stills', stage: 'stills', pieces: 11 },
          { step: 'animatic', name: 'Motion', stage: 'motion', pieces: 6 },
          { step: 'sound', name: 'Sound', stage: 'sound', pieces: 0 },
        ],
      } as T);
    if (type === 'step.cost')
      return Promise.resolve({
        step: params['step'],
        estimate_credits: 420,
        free: params['step'] !== 'sound',
        voice: null,
        ask_first: false,
        waiting: false,
      } as T);
    return Promise.reject(new Error('Nothing is changed in the demo.'));
  },
};
