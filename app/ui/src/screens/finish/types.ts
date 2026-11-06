// Shapes of what the Finish screen reads from the service (snake_case is the service's).

export type FinalState = 'none' | 'rendering' | 'done' | 'stale';

/** `final.status` */
export interface FinalStatus {
  state: FinalState;
  /** Path of the finished video in the studio folder. */
  file?: string;
  made_at?: string;
  length_sec?: number;
  size?: number;
  progress?: { done: number; total: number; phase?: string };
  job?: string;
  /** Waiting for its turn in the render queue. */
  queued?: boolean;
  renders_ahead?: number;
  /** What the film's sound really has (measured), and the sounds it left out with their reasons. */
  audio?: { music: number; sfx: number; lufs: number; true_peak: number; left_out?: { id: string; at_sec: number; what: string; why: string }[] } | null;
  /** The final-pass check of the film's sound against the plan (final.mjs, finalaudio.mjs checkFinalAudio). */
  audio_check?: { pass: boolean; problems: string[] } | null;
  /** Why the last try failed. */
  error?: string;
  /** What changed after the video was made (state 'stale'). */
  stale_why?: string;
}

/** What the film is made of, as the receipt shows it. */
export interface Counts {
  shots: number;
  lines: number;
  music: number;
  sfx: number;
  captions: number;
  markers: number;
}

/** The film itself: its title, picture size and how much of it is made. */
export interface FilmInfo {
  title: string;
  width?: number;
  height?: number;
  fps?: number;
  lengthSec: number;
  shotsTotal: number;
  shotsMade: number;
  /** Path of the first shot's picture. */
  poster?: string;
  counts: Counts;
}

/** One answer of `checks.run`. */
export interface Check {
  key: string;
  ok?: boolean;
  /** false = the check could not look (never a pass). */
  checked?: boolean;
  items?: { shot?: string; text?: string }[];
  /** Why it could not look (checked: false). */
  reason?: string;
  note?: string;
}

/** Where a problem is fixed. */
export interface FixTarget {
  route: '/motion' | '/sound';
  shot?: string;
}

/** The one thing that stops the video being made, in a plain sentence. */
export interface Blocker {
  text: string;
  label: string;
  target: FixTarget;
}

// ---- the service answers the film info is built from

export interface GraphAnswer {
  nodes?: { kind?: string; versions?: { path?: string }[] }[];
}

export interface VoiceMusicAnswer {
  length_sec?: number;
  shots?: { media?: { path?: string } }[];
}

export interface HandoffPlan {
  title?: string;
  sequence?: { name?: string; width?: number; height?: number; fps?: number; length_sec?: number };
  clips?: { kind?: string; track?: string }[];
  captions?: unknown[];
  markers?: unknown[];
}

export interface ChecksAnswer {
  checks?: Check[];
}
