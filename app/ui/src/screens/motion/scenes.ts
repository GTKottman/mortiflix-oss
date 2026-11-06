import type { PieceWhy } from '../../lib/review/waiting';
import { plural } from '../../lib/words';
import type { Mark } from '../../lib/components/StatusMark.svelte';
import { SOON } from './words';
import type { ClipStatus, Draft, Plan, PlanShot, Scene, SceneList, SceneNote, SceneVersion } from './types';

export const clock = (seconds: number): string => {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

export const frameAt = (seconds: number, fps: number): number => Math.round(seconds * fps);

/** "0:04.1 · frame 123" */
export const clockWithFrame = (seconds: number, fps: number): string =>
  `${clock(seconds)} · frame ${frameAt(seconds, fps)}`;

export interface SceneStatus {
  mark: Mark;
  text: string;
}

/**
 * Why a scene that is not made (or is marked making) is not there yet. Only a later scene waits for the one before
 * it; scene 1, or a scene whose turn it is, is being made, failed (the project stopped on a problem) or waits for
 * something named. null = the usual words apply.
 */
export function sceneWaitWords(scene: Scene, index: number, why: PieceWhy | null | undefined): string | null {
  if (!why || (scene.state !== 'waiting' && scene.state !== 'making')) return null;
  if (why.failed) return `Failed: ${why.failed}`;
  if (scene.state === 'making') return null;
  if (index > 0) return null; // waits for the scene before it: the usual words
  if (why.here) return 'Being made.';
  if (why.waiting) return `Waiting: ${why.waiting.body}`;
  return null;
}

/** The scene's state in a glyph and words. `index` is 0-based. `why` = what is known about the work behind it. */
export function statusOf(scene: Scene | undefined, index: number, why?: PieceWhy | null): SceneStatus {
  if (!scene) return { mark: 'wait', text: 'Waiting' };
  const wait = sceneWaitWords(scene, index, why);
  if (wait?.startsWith('Failed: ')) return { mark: 'cut', text: 'Failed' };
  if (wait === 'Being made.') return { mark: 'busy', text: 'Being made' };
  switch (scene.state) {
    case 'ok':
      return { mark: 'ok', text: 'Approved' };
    case 'failed':
      return { mark: 'cut', text: 'Failed' };
    case 'making':
      return { mark: 'busy', text: scene.clip || scene.versions?.length ? 'Regenerating' : 'Generating' };
    case 'review':
      return { mark: 'fix', text: 'Ready for review' };
    case 'ready':
      return { mark: 'wait', text: `Made, waiting for scene ${index} approval` };
    default:
      return { mark: 'wait', text: index > 0 ? `Waiting for scene ${index} approval` : 'Waiting' };
  }
}

export const failed = (scene: Scene): boolean => scene.state === 'failed' || Boolean(scene.error);

/** Version 1, 2, …: the service's list, or the one clip it has as Version 1. */
export function versionsOf(scene: Scene | undefined): SceneVersion[] {
  if (scene?.versions?.length) return scene.versions;
  return scene?.clip ? [{ n: 1, file: scene.clip.file }] : [];
}

export const latestNumber = (scene: Scene | undefined): number => versionsOf(scene).at(-1)?.n ?? 1;

export interface Viewing {
  /** Index into versionsOf(scene) of an older one picked; null = the newest. */
  picked: number | null;
  compare: boolean;
  side: 'before' | 'after';
}

/** The version on screen: the newest, an older one the owner picked, or one side of Compare. */
export function viewedVersion(versions: readonly SceneVersion[], viewing: Viewing): SceneVersion | null {
  if (!versions.length) return null;
  if (viewing.compare && versions.length > 1) return versions.at(viewing.side === 'before' ? -2 : -1) ?? null;
  return (viewing.picked !== null ? versions[viewing.picked] : undefined) ?? versions.at(-1) ?? null;
}

export const shotsOf = (plan: Plan | null, beat: string | null): PlanShot[] =>
  (plan?.shots ?? []).filter((shot) => shot.beat === beat);

/** The scene's length: every shot's dur_sec added up; undefined when no shot says its length. */
export function sceneLength(shots: readonly PlanShot[]): number | undefined {
  const known = shots.filter((shot) => typeof shot.dur_sec === 'number' && shot.dur_sec > 0);
  return known.length ? known.reduce((sum, shot) => sum + (shot.dur_sec ?? 0), 0) : undefined;
}

/** The shot the scene's picture comes from: a video first, else any picture, else the first. */
export function mainShot(shots: readonly PlanShot[]): PlanShot | null {
  return (
    shots.find((shot) => shot.media?.kind === 'video' && shot.media.path) ??
    shots.find((shot) => shot.media?.path) ??
    shots[0] ??
    null
  );
}

export const notesOfScene = (notes: readonly SceneNote[], shots: readonly PlanShot[]): SceneNote[] => {
  const nodes = new Set(shots.map((shot) => shot.node));
  return notes.filter((note) => nodes.has(note.node)).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
};

export const unresolvedOf = (notes: readonly SceneNote[]): SceneNote[] =>
  notes.filter((note) => note.pending && !note.resolved);

export const noteVersion = (note: SceneNote, latest: number): number => note.version ?? latest;

/** Where a note points, in words: "Whole scene", "0:04.1 – 0:05.2" or "0:02.4". */
export function noteWhere(note: SceneNote): string {
  if (note.kind === 'scene') return 'Whole scene';
  const start = clock(note.time ?? 0);
  return note.time_end !== undefined ? `${start} – ${clock(note.time_end)}` : start;
}

/** The second a note jumps the video to: its frame when it has one, else its time. */
export const noteSeconds = (note: SceneNote, fps: number): number =>
  note.frame !== undefined && note.frame >= 0 && note.kind !== 'scene' ? note.frame / fps : (note.time ?? 0);

export const etaText = (scene: Scene | undefined): string =>
  scene?.eta_s == null ? '' : ` · about ${Math.max(1, Math.round(scene.eta_s / 60))} min`;

export const sceneNumber = (index: number): string => `scene ${index + 1}`;

/** The scene to show: the one asked for (a beat or a shot id), else the studio's current one, else the first. */
export function pickBeat(
  list: SceneList,
  plan: Plan | null,
  current: string | null,
  asked: string | null,
): string | null {
  const valid = (beat: string | null | undefined): beat is string =>
    Boolean(beat) && list.scenes.some((s) => s.beat === beat);
  if (valid(current)) return current;
  const byShot = plan?.shots?.find((shot) => shot.node === asked)?.beat;
  if (valid(asked)) return asked;
  if (valid(byShot)) return byShot;
  const studio = list.scenes[Math.min(list.current ?? 0, list.scenes.length - 1)] ?? list.scenes[0];
  return studio?.beat ?? null;
}

export interface FootFacts {
  /** What is known about the work behind a scene that is not made. */
  why?: PieceWhy | null;
  busy: string;
  soon: boolean;
  scene: Scene;
  index: number;
  total: number;
  clip: ClipStatus;
  notes: number;
  unresolved: number;
  latest: number;
  lessons: number;
}

/** The sentence beside the decision buttons: why Approve or Request fix is or is not ready. */
export function decisionText(f: FootFacts): string {
  const { scene, index, total } = f;
  if (f.busy) return f.busy;
  if (f.soon) return SOON;
  const wait = sceneWaitWords(scene, index, f.why);
  if (wait) return wait;
  if (scene.state === 'waiting') {
    return index > 0 ? `Scene ${index + 1} waits for scene ${index} approval.` : 'Scene 1 is not made yet.';
  }
  if (scene.state === 'making') {
    return `◌ ${statusOf(scene, index).text} scene ${index + 1}${etaText(scene)}. You can still add notes.`;
  }
  if (scene.state === 'failed') return `Scene ${index + 1} could not be made. Your notes are kept.`;
  if (scene.state === 'ok') return `✓ Approved · Version ${f.latest}.`;
  if (f.clip === 'error') return 'The clip did not load. Try again before you approve or ask for a fix.';
  if (f.unresolved) {
    const them = f.unresolved === 1 ? 'it' : 'them';
    return `${plural(f.notes, 'note')} saved · ${f.unresolved} not sent. Request fix sends ${them} as one change and makes Version ${f.latest + 1}.`;
  }
  const saved = f.notes ? `${plural(f.notes, 'note')} saved, none waiting. ` : 'No notes. ';
  const next =
    index + 1 < total
      ? `scene ${index + 2} next, with ${plural(f.lessons, 'lesson')}`
      : 'the last scene final';
  return `${saved}Approving makes ${next}.`;
}

/** Where the note being written points, in words. */
export function draftWhere(draft: Draft, fps: number): string {
  if (draft.mode === 'scene') return 'Whole scene';
  if (draft.mode === 'range') {
    return draft.timeEnd === null
      ? `Range from ${clock(draft.time)} · press Set range end`
      : `Range ${clock(draft.time)} – ${clock(draft.timeEnd)}`;
  }
  return `${draft.locked ? 'Frame' : 'At the playhead'} ${clockWithFrame(draft.time, fps)}`;
}

export const emptyDraft = (): Draft => ({
  mode: 'frame',
  locked: false,
  time: 0,
  timeEnd: null,
  text: '',
  type: '',
});

export const NOTE_TYPES: readonly { id: string; label: string }[] = [
  { id: '', label: 'Type (optional)' },
  { id: 'timing', label: 'Timing' },
  { id: 'typography', label: 'Typography' },
  { id: 'composition', label: 'Composition' },
  { id: 'transition', label: 'Transition' },
  { id: 'motion', label: 'Motion behavior' },
  { id: 'pacing', label: 'Pacing' },
  { id: 'other', label: 'Other' },
];

export const noteTypeName = (id: string | undefined): string =>
  NOTE_TYPES.find((t) => t.id === id)?.label ?? '';

/** One frame, in seconds. */
export const stepSeconds = (fps: number): number => 1 / fps;
