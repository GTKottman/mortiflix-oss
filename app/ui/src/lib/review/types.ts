import type { ServiceClient } from '../service/client';

/** What the review pieces need from the service: the real client, or the fixture used for screenshots. */
export type ReviewService = Pick<ServiceClient, 'call' | 'on'>;

export type ItemState = 'waiting' | 'making' | 'review' | 'held' | 'ok';

export interface SectionCheck {
  pass: boolean;
  note?: string;
  correction?: string;
}

/** The AI's read of one picture, by section (visual design, type, …). */
export interface Inspection {
  rounds?: number;
  sections?: Record<string, SectionCheck>;
  unresolved?: string[];
  sent_anyway?: boolean;
}

export interface ItemVersion {
  v: number;
  path: string;
  notes: number;
}

export interface ReviewNote {
  id: string;
  text?: string;
  image?: string | null;
  pending?: boolean;
  lesson?: string | null;
}

/** What the tablet (Video Notes) says about this piece. */
export interface Tablet {
  status: string;
  notes: number;
}

export interface OkWords {
  notes: string;
  none: string;
}

/** One thing in review (a style frame or a still), in the same shape for both screens. `id` is the service's node id. */
export interface ReviewItem {
  id: string;
  noun: 'frame' | 'still';
  label: string;
  path: string;
  version: number;
  versions: ItemVersion[];
  state: ItemState;
  held: string[] | null;
  inspection: Inspection | null;
  /** What the studio measured and found wrong, in plain words. */
  problems: string[];
  /** "Look at: …" under the picture. */
  lookAt: string;
  notes: ReviewNote[];
  pending: number;
  tablet: Tablet | null;
  okWords: OkWords;
  /** Why a piece that is not made waits, in the screen's own words (else the decision row's default). */
  waitWords?: string;
  keyWord?: string;
  keyVisible?: boolean | null;
}

export interface Lesson {
  id: string;
  name?: string;
  text: string;
  approved?: boolean;
  scope?: string;
}

/** `videonotes.status` */
export interface VideoNotesStatus {
  enabled: boolean;
  addresses?: { kind: string; url: string; reachable: boolean }[];
  tablet_seen?: string | null;
  problems?: string[];
}

/** `frames.get` */
export interface FrameVersion {
  v: number;
  path: string;
  notes?: number;
  problems?: string[];
  inspection?: Inspection | null;
}

export type FrameState = 'todo' | 'writing' | 'fix' | 'review' | 'ok' | 'held' | 'skipped';

export interface FrameEntry {
  id: string;
  label: string;
  hold_s?: number;
  round: number;
  state: FrameState;
  version: number;
  versions?: FrameVersion[];
  path?: string;
  why?: string;
  note?: string;
  held?: string[] | null;
  inspection?: Inspection | null;
  pool_assets?: string[];
  pending_notes?: number;
  notes?: ReviewNote[];
  tablet?: Tablet | null;
  /** A frame with Fix pressed: false while its notes are kept (sent when every frame has a decision, or Send fixes). */
  fix_sent?: boolean | null;
}

export interface RoundUsage {
  round: number;
  /** 'write' (a new round) or 'fix' (a remake of frames in it). */
  kind?: string;
  calls: number;
  fixes?: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

export interface FramesState {
  planned?: number;
  enough?: boolean;
  total?: number;
  ok: number;
  round?: number;
  rounds?: number;
  waiting_for?: 'you' | 'studio' | 'done';
  ok_words: OkWords;
  frames: FrameEntry[];
  usage?: RoundUsage[];
  /** Frames with Fix pressed whose notes are kept, not sent yet. */
  fixes_waiting?: number;
}

/** `stills.get` */
export type StillLineState = 'todo' | 'drawing' | 'fix' | 'check' | 'held' | 'ok';

export interface StillLine {
  line: string;
  words: string;
  key_word?: string;
  beat?: string;
  path?: string;
  version?: number;
  /** A count (paths are derived from -vN.png) or the list itself. */
  versions?: number | ItemVersion[];
  state: StillLineState;
  held?: string[] | null;
  inspection?: Inspection | null;
  why?: string;
  error?: string;
  /** What the studio measured wrong on this version (empty when every check passes). */
  problems?: string[];
  check?: { key_word_visible?: boolean | null };
  pending_notes?: number;
  notes?: ReviewNote[];
  tablet?: Tablet | null;
}

export type SceneState = 'ok' | 'review' | 'making' | 'fixing' | 'waiting';

export interface StillGroup {
  beat: string;
  name: string;
  index: number;
  count: number;
  lines: string[];
  state: SceneState;
}

export interface StillsState {
  /** 'lines' is the demo studio: instant redraws and "Draw all". */
  mode: 'groups' | 'lines';
  groups?: StillGroup[];
  lines: StillLine[];
}

/** What the decision calls return: what comes next. */
export interface DecisionResult {
  next?: 'wait' | 'round' | 'group' | 'done';
}

export interface PoolInfo {
  packs?: { style?: string | null; assets?: string[] };
}
