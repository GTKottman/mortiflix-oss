import type { Beat, Decision, Drafts } from './types';
import { isApproved, isBusy, isOverItsTime, secondsLabel, type BeatTiming } from './timing';

import type { Tone } from '../../lib/components/StatusPill.svelte';

export interface Status {
  tone: Tone;
  /** Shown with the word, so colour is never the only signal. */
  glyph: string;
  text: string;
  title?: string;
}

/** What is being sent for a scene: an OK, a Reopen or an Undo last save. */
export type Pending = Decision | 'undo';

const SENDING: Record<Pending, string> = { ok: 'Sending OK…', clear: 'Reopening…', undo: 'Undoing save…' };

/** The scene's state, in words: Sending OK…, Reopening…, Undoing save…, Edited, Making, Approved, Cut or Needs review. */
export function stateOf(beat: Beat, drafts: Drafts, pending: Pending | undefined): Status {
  if (pending) return { tone: 'busy', glyph: '◌', text: SENDING[pending] };
  if (beat.lines.some((l) => l.id in drafts)) return { tone: 'fix', glyph: '✎', text: 'Edited' };
  if (isBusy(beat)) return { tone: 'busy', glyph: '◌', text: 'Making' };
  if (isApproved(beat)) return { tone: 'ok', glyph: '✓', text: 'Approved' };
  if (beat.state === 'cut') return { tone: 'wait', glyph: '–', text: 'Cut' };
  return { tone: 'wait', glyph: '○', text: 'Needs review' };
}

export function overTimeOf(beat: Beat, timing: BeatTiming | undefined): Status | null {
  if (!timing || !beat.target_sec || !isOverItsTime(beat, timing)) return null;
  return {
    tone: 'fix',
    glyph: '!',
    text: 'Over its time',
    title: `About ${secondsLabel(timing.dur)}; planned ${secondsLabel(beat.target_sec)}`,
  };
}
