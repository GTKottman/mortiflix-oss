// What the Voice & music screen says when there are no voice lines to show yet, by the voice step's state
// (service stage.status: blocked, ready, working, in_review, changes, approved, done, skipped). With lines, the
// screen itself is the state (Making / To check / OK on each line), so nothing here applies.
import { stageById, statusFor } from '../../lib/stages';
import type { StageStatus } from '../../lib/service/types';

export interface VoiceWaiting {
  title: string;
  body: string;
  /** Shows how long it has been making. */
  making?: boolean;
  /** The one action: a link to the stage the step waits for. */
  link?: { label: string; route: string };
}

export const VOICE_WAIT = {
  blocked: {
    title: 'Waiting for the script',
    body: 'The voice is recorded once the script is approved.',
    link: { label: 'Go to Script', route: '/script' },
  },
  ready: {
    title: 'Ready to record the voice',
    body: 'Nothing is recorded until you pick the voice and OK the cost below.',
  },
  working: {
    title: 'Mortiflix is recording the voice',
    body: 'The lines show here as they are made.',
    making: true,
  },
  changes: {
    title: 'Mortiflix is remaking the voice',
    body: 'Your notes are being worked in. The lines show here as they are made.',
    making: true,
  },
  done: { title: 'The voice is approved', body: 'There are no lines to show.' },
  skipped: { title: 'The voice was skipped', body: 'This video has no narration.' },
  unknown: {
    title: 'No voice lines yet',
    body: 'They show here when the script is approved and the voice is made.',
    link: { label: 'Go to Script', route: '/script' },
  },
} as const satisfies Record<string, VoiceWaiting>;

/** The voice step's state from the stage statuses, or null when the service does not list it. */
export function voiceStepState(statuses: readonly StageStatus[]): string | null {
  const steps = statusFor(stageById('voice'), statuses)?.steps ?? [];
  return (steps.find((step) => step.key === 'voice') ?? steps[0])?.state ?? null;
}

/** The words for a step with no lines; null when there are lines to show. */
export function voiceWaiting(state: string | null, lineCount: number): VoiceWaiting | null {
  if (lineCount > 0) return null;
  switch (state) {
    case 'blocked':
      return VOICE_WAIT.blocked;
    case 'ready':
      return VOICE_WAIT.ready;
    case 'working':
      return VOICE_WAIT.working;
    case 'changes':
      return VOICE_WAIT.changes;
    case 'approved':
    case 'done':
      return VOICE_WAIT.done;
    case 'skipped':
      return VOICE_WAIT.skipped;
    default:
      return VOICE_WAIT.unknown;
  }
}
