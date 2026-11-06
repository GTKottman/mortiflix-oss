// Shapes of what the Sound screen reads from the service (snake_case is the service's).

export type CueStatus = 'planned' | 'ready' | 'ok' | 'cut';
export type CueSource = 'library' | 'generate';

/** One sound on one action of one shot (`sfx.plan`). */
export interface Cue {
  id: string;
  shot: string;
  /** Seconds from the start of the film. */
  at_sec: number;
  dur_sec: number;
  /** The action it belongs to, e.g. "Callit". */
  what: string;
  /** What it sounds like. */
  prompt: string;
  source: CueSource;
  /** The made sound's file; missing = not made yet. */
  file?: string;
  gain_db?: number;
  status: CueStatus;
  /** A generated sound that was made before and costs nothing now. */
  from_library?: boolean;
  library_name?: string;
  /** Why this library sound was picked, or why none fit ("tear + paper: \"long paper tear rip\" (93%)"). */
  match?: string;
  /** This row's cost in ElevenLabs credits (0 when made, in your library or the same sound as an earlier row). */
  credits?: number;
  /** Made before in another project: free. */
  cached?: boolean;
  /** Why the last make failed, e.g. "came back nearly silent (peak -36.2 dBFS)": the sound stays to make. */
  failed?: string;
  /** 'finish' when the final sound left this sound out (e.g. inside a quoted line), with `note` saying why. */
  cut_by?: string;
  note?: string;
  /** This row uses the same sound as an earlier row (made once, no extra credits). */
  reuse?: { id: string; shot: string; shot_number: number; at_sec: number } | null;
}

/** A shot's place on the film's clock and where its narration talks. */
export interface PlanShot {
  id: string;
  number: number;
  name?: string;
  from: number;
  to: number;
  /** [start, end] seconds on the film's clock. */
  talk: [number, number][];
  /** The script beat this shot shows (b01). */
  beat?: string | null;
  /** The approved Motion clip of this shot, when the service has it. */
  clip?: ShotMedia | null;
}

export interface PlanSummary {
  cues: number;
  library: number;
  new: number;
  to_make: number;
  /** Distinct sounds among them: a repeated sound is made once. */
  sounds_to_make?: number;
  credits: number;
  made?: number;
}

export interface SoundPlan {
  shots: PlanShot[];
  cues: Cue[];
  /** The narration (and music) file played under a shot. */
  base?: string;
  summary: PlanSummary;
  /** The service can list the sounds (only once the motion is final). */
  can_plan?: boolean;
  /** Why the sounds can't be listed yet (with can_plan false): what is missing. */
  why?: string;
}

/** How far the motion stage is: Sound comes after it. */
export interface MotionProgress {
  total: number;
  ok: number;
  /** shot id (beat) -> motion node id, to ask for that shot's picture. */
  nodes: { id: string; beat?: string }[];
}

/** A shot's own picture or clip (`preview.plan`). */
export interface ShotMedia {
  path: string;
  kind?: string;
  /** Where in the clip the shot starts. */
  from_sec?: number;
}

/** Which sounds a make call is about. */
export type MakeScope = { all: true } | { shot: string };

/** `sfx.make`: without `confirm` it only says what it would do and spends nothing. */
export interface MakeAnswer {
  calls: number;
  credits: number;
  from_library?: string[];
  /** The price question's sounds to make (sfx.mjs makeSounds without confirm). */
  cues?: { id: string; dur_sec?: number; credits?: number }[];
  made?: string[];
  stopped?: { billing?: boolean; error?: string };
}

// ---- service answers read on the way

export interface GraphAnswer {
  nodes?: { id: string; beat?: string; kind?: string; state?: string }[];
}

export interface PreviewAnswer {
  shots?: { media?: ShotMedia }[];
}

/** What a cue change can set. */
export interface CueChange {
  prompt?: string;
  dur_sec?: number;
  at_sec?: number;
  source?: CueSource;
}

/** The OK shot button: nothing to OK, already signed, ready, or blocked with the reason. */
export type OkState =
  { kind: 'none' } | { kind: 'signed' } | { kind: 'ready' } | { kind: 'blocked'; reason: string };

/** `sfx.mix`: the voice and music with every kept sound, at its time. */
export interface MixAnswer {
  file: string;
  sounds: number;
  seconds?: number | null;
}
