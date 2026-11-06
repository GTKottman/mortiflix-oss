// The shapes the service answers for the Script screen (field names are the service's, snake_case).
// Only the fields the screen reads; the service sends more.

export interface Line {
  id: string;
  words: string;
  /** Still being written: cannot be edited yet. */
  read_only?: boolean;
  /** The owner edited these words at some time. Stays true after the voice is remade: never a sign the voice is stale. */
  changed?: boolean;
  /** The voice take says other words than this line now (the scene was rewritten): it needs a re-read. */
  words_changed?: boolean;
}

/** A scene's state as the canvas gives it; null before the scene is a piece on the canvas. */
export type BeatState = 'ready' | 'generating' | 'needs you' | 'approved' | 'cut' | null;

export interface Beat {
  id: string;
  no: number;
  name: string;
  /** What is on screen while the narration plays. */
  visual?: string;
  /** Seconds planned for this scene from the length chosen on New project. */
  target_sec?: number | null;
  state: BeatState;
  lines: Line[];
}

/** `script.get` */
export interface ScriptData {
  project: string;
  rev: number;
  /** The length chosen on New project, in seconds (needs service: script.get chosen_sec from the intake's length). */
  chosen_sec?: number | null;
  /** The narrator's measured pace, words a minute (script.get). */
  words_per_minute?: number | null;
  writing?: boolean;
  beats: Beat[];
  draft?: { lines: Record<string, string> } | null;
}

/** One line of `voice.lines` (the service answers a list). `path` is set once the voice file exists. */
export interface VoiceLine {
  node: string;
  start_sec?: number;
  dur_sec?: number | null;
  path?: string | null;
  /** The script's words changed after this take was made. */
  words_changed?: boolean;
}

/** One change `script.edit` takes: new words for a line, a line removed (delete) or brought back, a line added. */
export interface LineEdit {
  beat: string;
  line?: string;
  words?: string;
  /** true removes the line (kept, hidden, so Undo brings it back); false brings it back. */
  delete?: boolean;
  /** Adds a line after this line id (or an earlier added line's key); null = first in the scene. */
  add_after?: string | null;
  /** Names an added line so a later add in the same batch can go after it. */
  key?: string;
}

/** A line added in the editor, not saved yet. */
export interface NewLine {
  key: string;
  words: string;
}

/** `script.edit`: the line ids that changed and the pieces being remade from the new words. */
export interface EditResult {
  changed?: string[];
  /** Ids of the lines added, in the order sent. */
  added?: string[];
  deleted?: string[];
  remaking?: { node: string; kind: string; edit: string }[];
  /** Never sent by `script.edit`: only until script.svelte.ts drops its needs_confirm check (sweep request). */
  needs_confirm?: boolean;
  message?: string;
}

export type Decision = 'ok' | 'clear';
export type Drafts = Record<string, string>;
