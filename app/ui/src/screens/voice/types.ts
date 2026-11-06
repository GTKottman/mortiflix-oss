// Shapes of the service answers the Voice & music screen reads (field names are the service's).

export interface Colour {
  chip?: string;
}

export interface RecordedTake {
  take: number;
  seconds?: number;
  kept?: boolean;
  status?: string;
}

/** One line of the voice, from `voicemusic.view`. */
export interface VoiceLine {
  node: string;
  words: string;
  path: string | null;
  start_sec: number;
  dur_sec: number;
  beat: string;
  beat_no: number;
  colour?: Colour;
  /** 'approved' or still to check; 'generating' and friends while it is being made. */
  state: string;
  checked?: boolean;
  words_ok?: boolean | null;
  /** The script's words changed since the kept take was read: it still says the old words until a re-read. */
  words_changed?: boolean;
  takes?: RecordedTake[];
}

export interface VoiceView {
  length_sec?: number;
  voice: VoiceLine[];
  /** Credits per character ElevenLabs bills, measured by the service (about 0.44 for eleven_v4). */
  credit_rate?: number;
}

/** `voice.list`: the engine, and the service's own message when it has no key. */
export interface VoiceList {
  speaker?: string;
  needs_key?: string | null;
}

export interface WordTiming {
  text: string;
  start: number;
  end: number;
  extra?: boolean;
}

/** One line of `voice.check`: what was heard against the script. */
export interface LineCheck {
  id: string;
  role: string;
  text: string;
  tags: string[];
  gap_after: number | null;
  stability: number | null;
  checked: boolean;
  ok: boolean | null;
  missing: string[];
  extra: string[];
  words: WordTiming[];
}

export interface VoiceCheck {
  lines: LineCheck[];
}

export interface CastSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
}

export interface CastMember {
  role: string;
  name?: string;
  voice_id?: string;
  model?: string;
  v4?: boolean;
  engine?: string;
  settings?: CastSettings;
  gain_db?: number;
}

/** `cast.get` */
export interface CastAnswer {
  cast: CastMember[];
  set?: boolean;
  fallback?: CastMember;
}

export interface VoiceChoice {
  id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

/** `voices.list` */
export interface VoicesAnswer {
  voices?: VoiceChoice[];
  reason?: 'no_key' | 'bad_key' | 'unreachable';
  error?: string;
}

export type CueState = 'ok' | 'made' | 'stale' | 'planned';

export interface MusicCue {
  id: string;
  from_sec: number;
  to_sec: number;
  mood?: string;
  state: CueState;
  energy?: number;
  crossfade_sec?: number;
  duck_db?: number;
  credits?: number;
  prompt?: string;
  path?: string;
  from_library?: boolean;
}

/** `music.plan.get` */
export interface MusicPlan {
  enabled: boolean;
  /** The voice step makes the music (v3): it is not done until every cue is made and approved. */
  expected?: boolean;
  /** The cues the owner OK'd are being made now. */
  making?: boolean;
  mix?: string | null;
  /** The mix is older than the voice or a cue it was made from (asked of the service, see the audit HANDOFF);
      absent from older services. */
  mix_stale?: boolean;
  balance?: number | null;
  credits_per_sec_measured?: number | null;
  credits_per_sec?: number;
  total_sec?: number;
  cues: MusicCue[];
}

/** The numbers a `voice.line.set` / `voice.line.take` / `music.cue.make` answer carries when it asks first. */
export interface CostAnswer {
  retake?: boolean;
  credits?: number;
  credits_estimate?: number;
  characters?: number;
  needs_confirm?: boolean;
}

export interface TakeVersion {
  v: number | string;
  path: string | null;
}

/** The kept reads of a line, newest last; `plays` is the one in use. */
export interface TakeSet {
  versions: TakeVersion[];
  plays: number | string | null;
}

export interface NodeListEntry {
  id: string;
  versions?: { v: number | string; path?: string | null; file?: string | null }[];
  plays?: number | string;
  current?: number | string;
}

export interface PeaksAnswer {
  peaks?: number[];
}
