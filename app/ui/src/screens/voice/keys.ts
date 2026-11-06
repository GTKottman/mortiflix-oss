// The screen's keys, acting on the selected clip: Enter approves, F goes to its fix, Space plays it, the arrows move
// along the time line, N is the next issue, Esc lets go. Single keys never act while typing, with a modifier, or on a
// focused button or link (Enter and Space there belong to that control).

export type KeyAction = 'approve' | 'fix' | 'next' | 'play' | 'earlier' | 'later' | 'escape';

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;
const CONTROLS = /^(BUTTON|A|SUMMARY)$/;

const KEYS: Record<string, KeyAction> = {
  Enter: 'approve',
  f: 'fix',
  n: 'next',
  ' ': 'play',
  ArrowLeft: 'earlier',
  ArrowRight: 'later',
  Escape: 'escape',
};

/** What the key means right now, or null when it is not ours. `hasSelection`: a clip is selected. */
export function keyAction(input: KeyInput, hasSelection: boolean): KeyAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey || input.defaultPrevented) return null;
  const target = input.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = target?.tagName ?? '';
  if (TYPING.test(tag) || target?.isContentEditable) return null;
  const action = KEYS[input.key.length === 1 ? input.key.toLowerCase() : input.key];
  if (!action) return null;
  if ((action === 'approve' || action === 'play') && CONTROLS.test(tag)) return null;
  if ((action === 'play' || action === 'earlier' || action === 'later') && !hasSelection) return null;
  return action;
}

export const TONE_TAG_FIELD = 'voice-tone-tag';
export const CUE_PROMPT_FIELD = 'voice-cue-prompt';
