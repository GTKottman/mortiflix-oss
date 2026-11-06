import type { Lesson } from '../../lib/review/types';

// The service's answers for the Motion screen: `motion.scene.get`, `preview.plan`, `notes.list`, `lessons.list`.

/** `ready`: made ahead, it waits for the scene before it to be approved. */
export type SceneState = 'waiting' | 'making' | 'ready' | 'review' | 'ok' | 'failed';

export interface SceneVersion {
  n: number;
  file: string;
  /** ISO time it was made. */
  at?: string;
}

/** What the tablet (Video Notes) says about one scene. */
export interface SceneTablet {
  /** 'to review' | 'reviewing' | 'done', or 'not sent' when the send failed (then `error` says why). */
  status: string;
  notes?: number;
  error?: string | null;
}

export interface Scene {
  beat: string;
  name: string;
  state: SceneState;
  clip?: { file: string } | null;
  versions?: SceneVersion[];
  eta_s?: number | null;
  error?: string;
  tablet?: SceneTablet | null;
}

export interface SceneList {
  scenes: Scene[];
  /** 0-based index of the scene the studio is on. */
  current?: number;
  /** 'all' = the rest are being made together. */
  mode?: 'one' | 'all';
  fps?: number;
  /** The median time one scene took to make in this project (seconds); null = none timed yet. */
  make_s?: number | null;
  /** The scene after the current one, already made or being made ahead, and the notes written since it was started. */
  next?: { beat: string; made: boolean; notes: number; ask: boolean } | null;
}

export interface PlanShot {
  node: string;
  beat: string;
  dur_sec?: number;
  media?: { kind: string; path: string } | null;
}

export interface Plan {
  shots?: PlanShot[];
  fps?: number;
}

export type NoteKind = 'frame' | 'range' | 'scene';

export interface SceneNote {
  id: string;
  /** The shot the note is about. */
  node: string;
  time?: number;
  frame?: number;
  time_end?: number;
  kind?: NoteKind;
  text?: string;
  image?: string | null;
  audio?: string | null;
  pending?: boolean;
  resolved?: boolean;
  lesson?: string | null;
  type?: string;
  version?: number;
  /** Set when the note was written on the tablet. */
  tablet?: string | null;
}

export interface SceneLesson extends Lesson {
  /** Approved lessons can be switched off. */
  on?: boolean;
}

/** `motion.scene.all` without `confirm`: what making the rest at once would mean. */
export interface RestAnswer {
  needs_confirm?: boolean;
  rest?: number;
  warning?: string;
}

export interface NoteSaved {
  note?: { id: string } | string;
}

/** What `notes.save` takes for one note. */
export interface NotePayload {
  node: string;
  time: number;
  frame: number;
  text: string;
  image_png_base64: string;
  send: false;
  kind: NoteKind;
  version: number;
  fps: number;
  type?: string;
  time_end?: number;
  frame_end?: number;
  audio_base64?: string;
  audio_ext?: string;
}

/** The note being written: where it points, and its words. */
export interface Draft {
  mode: NoteKind;
  /** The playhead was pinned by Mark frame / Mark range; until then the note follows the playhead. */
  locked: boolean;
  time: number;
  timeEnd: number | null;
  text: string;
  type: string;
}

export type ClipStatus = 'idle' | 'loading' | 'ready' | 'error';
