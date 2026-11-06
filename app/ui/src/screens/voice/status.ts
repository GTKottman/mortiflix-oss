// The state word shown beside a selected line or music cue, as StatusPill takes it.
import type { Tone } from '../../lib/components/StatusPill.svelte';
import { plural } from '../../lib/words';
import type { CueState, VoiceLine } from './types';

export interface StatusWord {
  tone: Tone;
  glyph: string;
  text: string;
}

export function lineStatus(line: Pick<VoiceLine, 'state'>, making: boolean): StatusWord {
  if (making) return { tone: 'busy', glyph: '◌', text: 'Making' };
  if (line.state === 'approved') return { tone: 'ok', glyph: '✓', text: 'OK' };
  return { tone: 'fix', glyph: '!', text: 'To check' };
}

const CUE_WORDS: Record<CueState, StatusWord> = {
  ok: { tone: 'ok', glyph: '✓', text: 'OK' },
  planned: { tone: 'fix', glyph: '○', text: 'Not made' },
  stale: { tone: 'fix', glyph: '↻', text: 'Words changed' },
  made: { tone: 'fix', glyph: '!', text: 'To check' },
};

export function cueStatus(state: CueState, queued: boolean): StatusWord {
  return queued ? { tone: 'busy', glyph: '◌', text: 'Queued' } : CUE_WORDS[state];
}

/** "3 words differ", or just "words differ" when the check has no list. */
export const differenceNote = (words: number): string =>
  words ? `${plural(words, 'word')} ${words === 1 ? 'differs' : 'differ'}` : 'words differ';
