// The title and subtitle of the audio inspector for a selected line or music cue.
import { cueName, voiceClock } from './review';
import type { MusicCue, VoiceLine } from './types';

/** "Narrator · Mark", or just "Narrator" when the voice has no name. */
export const spokenBy = (speaker: { role: string; name: string }): string =>
  `${speaker.role}${speaker.name ? ` · ${speaker.name}` : ''}`;

export const lineSubtitle = (line: VoiceLine, spoken: string): string =>
  `${voiceClock(line.start_sec)}–${voiceClock(line.start_sec + line.dur_sec)} · ${spoken}`;

export const cueTitle = (cue: MusicCue): string => `${cueName(cue.id)} · ${cue.mood || 'Untitled'}`;

export const cueSubtitle = (cue: MusicCue): string =>
  `${voiceClock(cue.from_sec)}–${voiceClock(cue.to_sec)} · blends ${cue.crossfade_sec ?? 0} s into the next${cue.from_library ? ' · from your library' : ''}`;
