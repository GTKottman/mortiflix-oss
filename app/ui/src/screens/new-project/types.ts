// The shapes this screen reads from the service (review/plans/new-project-brief-contract.md). Names are the service's.

/** Anything a setting can hold. */
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

/** The settings the owner touched, by section then key: `{ story: { audience: '…' } }`. Absent = default. */
export type Settings = Record<string, Record<string, Value>>;

export type FieldType = 'choice' | 'multi' | 'text' | 'long' | 'list' | 'number' | 'bool' | 'object';

export interface Choice {
  value: string | number;
  label: string;
  hint?: string;
}

export interface SchemaPart {
  key: string;
  type: FieldType;
  choices?: Choice[];
  min?: number;
  max?: number;
  help?: string;
}

export interface SchemaField {
  id: string;
  section: string;
  label: string;
  type: FieldType;
  choices?: Choice[];
  parts?: SchemaPart[];
  default: Value;
  custom?: boolean;
  min?: number;
  max?: number;
  help?: string;
}

export interface SchemaSection {
  id: string;
  label: string;
  summary: string;
  fields: SchemaField[];
}

export interface Checkpoint {
  value: string;
  label: string;
  hint?: string;
}

/** `brief.schema` */
export interface BriefSchema {
  quick: string[];
  sections: SchemaSection[];
  checkpoints: Checkpoint[];
}

export type DecideKey = 'voice' | 'music' | 'sound_design' | 'pauses';
export type DecideLater = Partial<Record<DecideKey, boolean>>;

export type SourceStatus = 'fetching' | 'ready' | 'stored' | 'failed';

/** One entry of the source tray as the service sends it. */
export interface ServiceSource {
  id: string;
  kind: string;
  label?: string;
  name?: string;
  url?: string;
  bytes?: number;
  status: SourceStatus;
  status_text?: string;
  error?: string;
}

export type BriefLabel = 'specified' | 'suggested' | 'default';

export interface Resolution {
  text: string;
  set: Record<string, Value>;
}

export interface Conflict {
  id: string;
  paths: string[];
  text: string;
  resolutions?: Resolution[];
}

export interface SummaryEstimate {
  seconds?: number | null;
  speaking_words_about?: number;
  scenes_about?: number;
  deliverables?: { count: number; shapes: string[] };
}

/** `brief.summary` */
export interface Summary {
  sentences: { section: string; path: string; text: string; label: BriefLabel }[];
  missing?: { path: string; text: string }[];
  conflicts?: Conflict[];
  sources?: { total: number; ready: number; reading?: number; failed?: number };
  estimate?: SummaryEstimate;
}

export interface Suggestion {
  id: string;
  kind: 'set' | 'clarify';
  path?: string;
  value?: Value;
  label: string;
  why?: string;
}

/** A named brief the owner can apply again. */
export interface Preset {
  name: string;
  brief: Record<string, Value>;
  slug?: string;
  template?: boolean;
}
