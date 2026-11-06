import type { StageStatus, StepState } from './service/types';

// The v3 stages, in order. `keys` = the stage's entries in `stage.status` (first match wins);
// `index` = the service's stage index for `stage.set`. Finish is a stage but not a link in the stage line:
// Sound's Next leads there.

export type StageId = 'script' | 'voice' | 'look' | 'stills' | 'motion' | 'sound' | 'finish';

export interface Stage {
  id: StageId;
  label: string;
  keys: readonly string[];
  index: number;
  /** What the count names, e.g. "4 of 6 stills OK". */
  noun?: string;
  inLine: boolean;
}

export const STAGES: readonly Stage[] = [
  { id: 'script', label: 'Script', keys: ['script'], index: 0, inLine: true },
  { id: 'voice', label: 'Voice & music', keys: ['voiceMusic', 'voice'], index: 1, inLine: true },
  { id: 'look', label: 'Look', keys: ['look', 'styleFrames'], index: 2, noun: 'looks', inLine: true },
  // Stills is no stage any more (owner, 2026-11-04: "All of these looks ARE frames the step is reduntent"): Look's Next
  // leads to Motion. Kept out of the line so old links still open.
  { id: 'stills', label: 'Stills', keys: ['stills'], index: 3, noun: 'stills', inLine: false },
  { id: 'motion', label: 'Motion', keys: ['motion', 'animatic'], index: 4, noun: 'scenes', inLine: true },
  { id: 'sound', label: 'Sound', keys: ['sound'], index: 5, noun: 'sounds', inLine: true },
  { id: 'finish', label: 'Finish', keys: [], index: 6, inLine: false },
];

export const STAGE_LINE = STAGES.filter((stage) => stage.inLine);

export const isStageId = (value: string): value is StageId => STAGES.some((stage) => stage.id === value);

export function stageById(id: StageId): Stage {
  const stage = STAGES.find((s) => s.id === id);
  if (!stage) throw new Error(`unknown stage ${id}`);
  return stage;
}

export function nextStage(id: StageId): Stage | null {
  return STAGES.slice(STAGES.findIndex((s) => s.id === id) + 1).find((s) => s.inLine || s.id === 'finish') ?? null;
}

export function statusFor(stage: Stage, statuses: readonly StageStatus[]): StageStatus | null {
  for (const key of stage.keys) {
    const found = statuses.find((s) => s.key === key);
    if (found) return found;
  }
  return null;
}

/** Step states that count as finished: the owner approved it, or it needs no review and is done, or it was skipped. */
const STEP_FINISHED = ['approved', 'done', 'skipped'];

/**
 * A stage is done only when every one of its steps is finished: a step still in review (Voice made, 0 of 15 lines
 * approved) is not done, whatever the piece count says (RUN-BUGS Dir3: "✓ Voice & music" while in review).
 */
export function isStageDone(status: StageStatus | null): boolean {
  if (!status) return false;
  if (status.steps?.length) return status.steps.every((step) => STEP_FINISHED.includes(step.state));
  const total = status.total ?? 0;
  return total > 0 ? (status.done ?? 0) >= total : status.kind === 'done';
}

export interface StageCount {
  /** The words left of Next, e.g. "4 of 6 stills OK". */
  text: string;
  /** Next can be used: the stage's step is approved (every piece OK'd or cut). Owner's gate rule: no moving on past
   *  anything not approved; the same rule greys later stages in StageLine. */
  ready: boolean;
  /** Why Next is greyed (its hover), e.g. "2 of 3 looks still need your OK". */
  why?: string;
}

const stepsWaitingForOk = (status: StageStatus): StepState[] =>
  (status.steps ?? []).filter((step) => step.state === 'in_review');

/** "Brief needs your OK", "Brief and Script need your OK". */
export function needsOkText(steps: readonly StepState[]): string {
  const names = steps.map((step) => step.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `${list} ${names.length > 1 ? 'need' : 'needs'} your OK`;
}

/**
 * The count and Next state for the stage on screen. Same wording as web/chrome.js. "N of M looks OK" counts the owner's
 * OKs (`ok`), never what is made (`done`: Dir2 2026-11-02 saw "3 of 3 looks OK" with 0 frames OK'd); an older service
 * without `ok` says "made". Before the statuses load (`loaded` false) there is no count at all.
 */
export function stageCount(stage: Stage, status: StageStatus | null, loaded = true): StageCount {
  if (stage.id === 'finish') return { text: 'Finish', ready: false };
  if (!loaded) return { text: '', ready: false };
  const next = nextStage(stage.id);
  const total = status?.total ?? 0;
  const done = status?.done ?? 0;
  if (status && total > 0) {
    // The service's text is "3/8 stills" (a noun to keep) or "1 needs you" (no noun: name the steps instead).
    const counted = /^\d+\/\d+\s/.test(status.text ?? '');
    const waiting = stage.noun || counted ? [] : stepsWaitingForOk(status);
    const okd = status.ok;
    // approved: the stage's steps are (StageLine's rule), or every piece is OK'd; with no steps listed, the OKs decide
    const approved =
      (okd !== undefined && okd >= total) ||
      (status.steps?.length || okd === undefined ? isStageDone(status) : false);
    const ready = approved && next !== null;
    const gate = (why: string): StageCount => (ready || !next ? { text, ready } : { text, ready, why });
    let text: string;
    if (waiting.length > 0) {
      text = needsOkText(waiting);
      return gate(text);
    }
    const noun = stage.noun ?? (counted ? (status.text ?? '').replace(/^\d+\/\d+\s*/, '') : '');
    text = `${okd ?? done} of ${total}${noun ? ` ${noun}` : ''} ${okd === undefined ? 'made' : 'OK'}`;
    const left = total - (okd ?? 0);
    return gate(
      okd !== undefined && left > 0
        ? `${left} of ${total}${noun ? ` ${noun}` : ''} still ${left === 1 ? 'needs' : 'need'} your OK`
        : `${stage.label} needs your OK first`,
    );
  }
  return next
    ? { text: `Waiting for ${stage.label}`, ready: false, why: `Waiting for ${stage.label}` }
    : { text: '', ready: false };
}
