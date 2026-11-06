// The Brief step before the Script, read from what the service really says: `stage.status` steps, the
// SUBMITTED event's note, and the chat's submission card (the questions).

import type { StepState } from '../../lib/service/types';

export interface BriefQuestion {
  id: string;
  text: string;
  choices: string[] | null;
  default: string | null;
}

export interface ProjectEvent {
  t: string;
  event: string;
  step?: string | null;
  version?: number | null;
  details?: string;
}

export interface ChatRow {
  card?: { kind?: string; step?: string; version?: number; questions?: BriefQuestion[] };
}

/** What the screen is waiting on while no scene exists yet. */
export type Waiting =
  | { kind: 'review'; step: StepState }
  | { kind: 'writing'; step: StepState }
  | { kind: 'idle'; next: StepState | null };

const WRITING = ['working', 'changes'];

export function whatIsWaiting(steps: readonly StepState[], sessionRunning: boolean): Waiting {
  const review = steps.find((step) => step.state === 'in_review');
  if (review) return { kind: 'review', step: review };
  // A running session works on the step in hand, or else on the next one in line: Claude often starts writing it
  // before the step itself says "working" (2026-11-02 real run: "queued" for 4 minutes while the brief was written).
  const writing =
    steps.find((step) => WRITING.includes(step.state)) ?? steps.find((step) => step.state === 'ready');
  if (writing && sessionRunning) return { kind: 'writing', step: writing };
  return {
    kind: 'idle',
    next: steps.find((step) => step.state === 'ready' || WRITING.includes(step.state)) ?? null,
  };
}

/** "the brief", "the script": a step named the way a sentence needs it. */
export const stepWords = (step: StepState): string => `the ${step.name.toLowerCase()}`;

/** The note Claude submitted with this version of the step. */
export function submittedNote(events: readonly ProjectEvent[], step: StepState): string {
  const found = [...events]
    .reverse()
    .find(
      (e) =>
        e.event === 'SUBMITTED' &&
        e.step === step.key &&
        (step.version == null || e.version === step.version),
    );
  return found?.details?.trim() ?? '';
}

export function submittedQuestions(rows: readonly ChatRow[], step: StepState): BriefQuestion[] {
  const card = [...rows]
    .reverse()
    .map((row) => row.card)
    .find(
      (c) =>
        c?.kind === 'submission' &&
        c.step === step.key &&
        (step.version == null || c.version === step.version),
    );
  return card?.questions ?? [];
}

/** When the running session began: the last SESSION_STARTED with no SESSION_ENDED after it. */
export function sessionStartedAt(events: readonly ProjectEvent[]): number | null {
  for (const e of [...events].reverse()) {
    if (e.event === 'SESSION_ENDED') return null;
    if (e.event === 'SESSION_STARTED') return Date.parse(e.t) || null;
  }
  return null;
}

/** The answer an OK sends for each question: the owner's pick, else the suggested one. Null = a question has neither. */
export function answersFor(
  questions: readonly BriefQuestion[],
  picked: Readonly<Record<string, string>>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const value = picked[q.id] ?? q.default;
    if (value == null) return null;
    out[q.id] = value;
  }
  return out;
}

/** A copy of `record` without `key` (state records are replaced, not mutated, so readers see the change). */
export function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}
