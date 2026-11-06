import { isStageDone, STAGE_LINE, statusFor, type Stage } from '../stages';
import type { StageStatus, StepState } from '../service/types';

// Honest waiting: a stage screen says "Working for 1:05" only while the service reports work for this project and
// this stage (`work.get` / `work.active`). Otherwise it says what it waits for, read from the step states.

/** What `work.get` and the `work.active` push say (only the parts read here). */
export interface WorkReport {
  project?: string | null;
  running?: boolean;
  /** The step the runner is on; `stage` is the service's stage index. Null while it does the owner's Fixes. */
  step?: { key?: string; name?: string; stage?: number } | null;
  /** The runner's queue for this project: `ahead` = queued projects before it (null when it isn't waiting for a slot). */
  queue?: { ahead: number | null; running?: number; slots?: number } | null;
  /** A drained restart under way (`service.drain`); null when there is none. */
  drain?: Drain | null;
}

/** `service.drain`: the studio restarts once the running steps of `waiting_for` end (at most `wait_min` after `started_at`). */
export interface Drain {
  draining: boolean;
  waiting_for?: string[];
  titles?: Record<string, string>;
  started_at?: string;
  wait_min?: number;
}

/** A queued project: the projects ahead of it, and the drained restart it also waits for (if any). */
export interface Queued {
  ahead: number;
  drain?: Drain | null;
}

/**
 * While the studio drains for a restart, queued work starts after it (Dir1 bdb9, 2026-11-02: Sound said "can't list
 * the sounds yet" and Check again did nothing). "Queued: the studio restarts once Flock cameras finishes its running
 * step (≤ 7 min); this starts then." Null when no drain is under way.
 */
export function drainWords(drain: Drain | null | undefined, now = Date.now()): WaitingWords | null {
  if (!drain?.draining) return null;
  const names = (drain.waiting_for ?? []).map((id) => drain.titles?.[id] || id);
  const who =
    names.length === 0
      ? 'the running steps end'
      : names.length === 1
        ? `${names[0]} finishes its running step`
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} finish their running steps`;
  // Date.parse answers NaN for a time it cannot read (MDN): then the minutes are left out, never "≤ NaN min".
  const started = drain.started_at ? Date.parse(drain.started_at) : now;
  const left = Math.max(1, Math.ceil((drain.wait_min ?? 10) - (now - started) / 60_000));
  const limit = Number.isFinite(left) ? ` (≤ ${left} min)` : '';
  return {
    title: 'Queued',
    body: `Queued: the studio restarts once ${who}${limit}; this starts then.`,
  };
}

/** True when the service is working on this project, in this stage (or on Fixes, which can be this stage's). */
export function workHere(work: WorkReport | null, projectId: string | null, stage: Stage): boolean {
  if (!work?.running) return false;
  if (work.project && projectId && work.project !== projectId) return false;
  return work.step?.stage === undefined || work.step.stage === stage.index;
}

/**
 * What a stopped project says went wrong, for a piece that is not made: the service's own sentence (before its
 * "Likely cause"), else the Fix it strip's words.
 */
export function failedWords(need: { text?: string } | null | undefined, strip = ''): string {
  const own = (need?.text ?? '').split(/\s+Likely cause:/)[0]?.trim() ?? '';
  return own || strip;
}

/** What is known about the work behind a piece that is not made. */
export interface PieceWhy {
  /** The service works on this stage now (a session runs for this project). */
  here: boolean;
  /** The project stopped on a problem (its own words); '' = it did not. */
  failed: string;
  /** Nothing runs: what the stage waits for, if anything. */
  waiting: WaitingWords | null;
}

export interface WaitingWords {
  title: string;
  body: string;
  /** The stage it waits for, to link there. */
  link?: { label: string; route: string };
  /** Nothing blocks this stage and nothing runs: offer Resume. */
  idle?: boolean;
}

/** [one, many]: "The script isn't made yet", "The style frames aren't made yet". */
const STATE_WORDS: Record<string, readonly [string, string]> = {
  working: ['is being made', 'are being made'],
  changes: ['is being changed with your notes', 'are being changed with your notes'],
  in_review: ['needs your OK', 'need your OK'],
  ready: ["isn't made yet", "aren't made yet"],
  blocked: ["isn't made yet", "aren't made yet"],
};

/** A step's name as a sentence starts it: "The style frames" (a name ending in one s is many). */
export function stepWords(step: StepState): string {
  const name = (step.name || step.key).trim();
  const many = /[^s]s$/i.test(name);
  const words = STATE_WORDS[step.state] ?? STATE_WORDS['ready'] ?? ["isn't made yet", "aren't made yet"];
  return `The ${name.charAt(0).toLowerCase()}${name.slice(1)} ${words[many ? 1 : 0]}`;
}

/** The first step that is not finished in a stage. */
const openStep = (status: StageStatus | null): StepState | undefined =>
  status?.steps?.find((step) => !['approved', 'done', 'skipped'].includes(step.state));

/**
 * What a stage screen says when nothing runs for it: the earlier stage it waits for (with its first open step), or
 * that Mortiflix is not working on it right now. `what` names the stage's pieces ("the frames").
 */
export function waitingWords(
  stage: Stage,
  statuses: readonly StageStatus[],
  what: string,
  /** The project is queued for a session slot: the projects ahead of it (Dir1, 2026-11-02: Resume answered "not paused
   *  (queued)"), with the drained restart it also waits for. */
  queued: number | Queued | null = null,
): WaitingWords {
  for (const before of STAGE_LINE.filter((s) => s.index < stage.index)) {
    const status = statusFor(before, statuses);
    if (!status || isStageDone(status)) continue;
    const step = openStep(status);
    const lower = before.label.charAt(0).toLowerCase() + before.label.slice(1);
    return {
      title: `Waiting for ${before.label}`,
      body: step
        ? `${stepWords(step)}, so ${what} can't start yet.`
        : `${before.label} isn't finished, so ${what} can't start yet.`,
      link: { label: `Go to ${lower} ›`, route: `/${before.id}` },
    };
  }
  if (queued !== null)
    return typeof queued === 'number'
      ? queuedWords(queued)
      : (drainWords(queued.drain) ?? queuedWords(queued.ahead));
  const step = openStep(statusFor(stage, statuses));
  return {
    idle: true,
    title: 'Nothing is running right now',
    body: step
      ? `${stepWords(step)}, but Mortiflix is not working on ${what} at the moment. It goes on when the project runs again.`
      : `Mortiflix is not working on ${what} at the moment. It goes on when the project runs again.`,
  };
}

/** A queued project: it starts by itself when a session slot frees, so there is nothing to press. */
export function queuedWords(ahead: number): WaitingWords {
  return { title: 'Queued', body: `Queued: starts when a slot frees (${ahead} ahead).` };
}
