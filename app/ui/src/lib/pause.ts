import { costScreens, costWaitText, isCostWait } from './cost-ok';
import type { NeedsYou } from './service/types';
import { stageById, type StageId } from './stages';

// What the Fix it strip says when a project is not moving, and the one button it offers.
// Old rules (web/chrome.js drawNeeds): paused + needs_you -> one strip, the cause in plain words (else the service's
// text cut to 160), 'bad' only for billing, "Let the AI take over" when needs_you.takeover. Added from the
// service protocol (a pause with no button was the dead end): Resume, Check again, Add key, Start.

/** Old words per cause (web/chrome.js CAUSE_TEXT). */
export const STRIP_CAUSE: Readonly<Record<string, string>> = {
  'gave-up': 'The AI got stuck on this step.',
  gpu: 'The graphics card is busy.',
  login: 'Claude Code needs you to sign in.',
  billing: 'A paid service ran out of credits.',
  stopped: 'The AI stopped before it finished.',
};

export const WAITING_ON_YOU = 'The AI is waiting on you.';
export const DRAFT_TEXT = 'This project has not started yet.';
/** Stop is not final (owner 2026-11-03): the old app's words for a stopped project (runner.mjs "Press Resume to carry on"). */
export const CANCELLED_TEXT = 'This project was stopped. Press Resume to carry on.';
const TEXT_MAX = 160;

export type PauseRun = 'resume' | 'recheck' | 'takeover' | 'start' | 'add-key' | 'cost';

export interface PauseAction {
  label: string;
  run: PauseRun;
}

export interface PauseView {
  text: string;
  kind: 'warn' | 'bad';
  /** The main button. A paused project always offers Resume (or what its cause needs first: sign in, a key). */
  action: PauseAction | null;
  /** The second, quieter button: "Let the AI take over" when the service offers it. */
  second?: PauseAction | null;
}

export const ACTION: Readonly<Record<PauseRun, PauseAction>> = {
  resume: { label: 'Resume', run: 'resume' },
  recheck: { label: 'Check again', run: 'recheck' },
  takeover: { label: 'Let the AI take over', run: 'takeover' },
  start: { label: 'Start', run: 'start' },
  'add-key': { label: 'Add key', run: 'add-key' },
  cost: { label: 'Go to the cost', run: 'cost' },
};

/** The service's "this project needs your <key>" pause carries no cause. */
export const isMissingKey = (need: NeedsYou): boolean => /^This project needs your /.test(need.text ?? '');

function pausedAction(need: NeedsYou): PauseAction {
  if (need.cause === 'login') return ACTION.recheck;
  if (!need.cause && isMissingKey(need)) return ACTION['add-key'];
  return ACTION.resume;
}

/** Cost first: the stage screen holds the Make button with the cost (Resume would only wait again). On that
    screen the strip offers nothing; elsewhere it leads there ("Go to Voice & music"). */
function costAction(need: NeedsYou, here: StageId | null): PauseAction | null {
  const screens = costScreens(need);
  if (here && screens.includes(here)) return null;
  const to = screens[0] ?? 'voice';
  return { label: `Go to ${stageById(to).label}`, run: 'cost' };
}

/** null = nothing to show (working, waiting for an OK, or delivered). `here` = the stage screen on view. */
export function pauseView(
  state: string | null | undefined,
  need: NeedsYou | null | undefined,
  here: StageId | null = null,
): PauseView | null {
  if (state === 'draft') return { text: DRAFT_TEXT, kind: 'warn', action: ACTION.start };
  if (state === 'cancelled') return { text: CANCELLED_TEXT, kind: 'warn', action: ACTION.resume };
  if (state !== 'paused' || !need) return null;
  if (isCostWait(need)) return { text: costWaitText(need), kind: 'warn', action: costAction(need, here) };
  // gave-up: the service's own sentence says what failed; the part before "Likely cause" is the one to show
  const own =
    need.cause === 'gave-up' && need.text
      ? String(need.text)
          .split(/\s*Likely cause:/)[0]
          ?.trim()
      : '';
  const text =
    own ||
    STRIP_CAUSE[need.cause ?? ''] ||
    (need.text ? String(need.text).slice(0, TEXT_MAX) : WAITING_ON_YOU);
  return {
    text,
    kind: need.cause === 'billing' ? 'bad' : 'warn',
    action: pausedAction(need),
    second: need.takeover ? ACTION.takeover : null,
  };
}

export interface PauseDeps {
  call: <T>(type: string, params?: Record<string, unknown>) => Promise<T>;
  project: string;
  openVoiceSettings: () => void;
  /** Opens the screen with the cost OK (run 'cost'). */
  openStage?: (stage: StageId) => void;
  /** The pause the action answers (run 'cost' reads its step). */
  need?: NeedsYou | null;
}

interface RecheckAnswer {
  resumed?: boolean;
  why?: string;
}

/** Does the action; returns what was done, or throws the service's reason (the strip shows it). */
export async function runPause(run: PauseRun, deps: PauseDeps): Promise<string> {
  const params = { project: deps.project };
  switch (run) {
    case 'takeover': {
      // the service's answer says what happened (its event: RESUMED "Let the AI take over"), never assumed
      const answer = await deps.call<{ takeover?: boolean } | undefined>('project.takeover', params);
      return answer?.takeover
        ? 'The AI took over: a full session may run. It goes on by itself.'
        : 'Resumed. It goes on by itself.';
    }
    case 'resume':
      await deps.call('project.resume', params);
      return 'Resumed. It goes on by itself.';
    case 'start':
      await deps.call('project.start', params);
      return 'Started. It goes on by itself.';
    case 'recheck': {
      const answer = await deps.call<RecheckAnswer>('project.recheck', params);
      if (!answer?.resumed) throw new Error(answer?.why || 'it is not clear yet');
      return 'Clear again. It goes on by itself.';
    }
    case 'add-key':
      deps.openVoiceSettings();
      return 'Opening Settings…';
    case 'cost': {
      const to = deps.need ? (costScreens(deps.need)[0] ?? 'voice') : 'voice';
      deps.openStage?.(to);
      return `Opening ${stageById(to).label}…`;
    }
  }
}

export const RUNNER_TAKEN_ID = 'runner-taken';
/** hello answered runner:false: the strip says the service's own note; no button. */
export const runnerTakenText = (note: string | null | undefined): string | null => (note ? note : null);
