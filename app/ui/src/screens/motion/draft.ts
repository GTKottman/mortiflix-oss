import type { Draft } from './types';

/** Shortest range a note can cover; a double press at one spot still marks something. */
const MIN_RANGE = 0.05;
const MIN_RANGE_PADDING = 0.1;

/** Mark frame: the note is about this instant. */
export const pinFrame = (draft: Draft, time: number): Draft => ({
  ...draft,
  mode: 'frame',
  locked: true,
  time,
  timeEnd: null,
});

/** Mark range: the first press sets the start, the second sets the end (in either order). */
export function pinRange(draft: Draft, now: number): Draft {
  if (draft.mode === 'range' && draft.locked && draft.timeEnd === null) {
    const [start, end] = now < draft.time ? [now, draft.time] : [draft.time, now];
    return { ...draft, time: start, timeEnd: end - start < MIN_RANGE ? start + MIN_RANGE_PADDING : end };
  }
  return { ...draft, mode: 'range', locked: true, time: now, timeEnd: null };
}

/** A note about the whole scene, not a moment of it. */
export const pinScene = (draft: Draft): Draft => ({ ...draft, mode: 'scene', locked: true, timeEnd: null });

/** Recording a voice note on a free-running frame note pins it to the instant recording starts. */
export const pinForVoice = (draft: Draft, time: number): Draft =>
  !draft.locked && draft.mode === 'frame' ? { ...draft, locked: true, time } : draft;

/** What stops a note from being added, in words; null = it can be added. */
export function draftProblem(draft: Draft, hasVoice: boolean): { text: string; focus: boolean } | null {
  if (!draft.text.trim() && !hasVoice) return { text: 'Write or speak a note first.', focus: true };
  if (draft.mode === 'range' && draft.timeEnd === null) {
    return { text: 'Press Set range end at the end of the stretch, or Cancel.', focus: false };
  }
  return null;
}

/** A note half written on a scene the owner left, kept by scene. */
export interface Parked {
  draft: Draft;
  audio: Blob | null;
}

export class ParkedDrafts {
  readonly #byScene = new Map<string, Parked>();

  park(beat: string, parked: Parked): void {
    this.#byScene.set(beat, parked);
  }

  /** The note parked on this scene, removed from the shelf. */
  take(beat: string): Parked | undefined {
    const parked = this.#byScene.get(beat);
    this.#byScene.delete(beat);
    return parked;
  }
}
