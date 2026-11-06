export interface AssetFile {
  path: string;
  rel: string;
  name: string;
  size: number;
  modified: string;
  kind: 'image' | 'audio' | 'video' | 'text' | 'other';
}

export interface AssetGroup {
  key: string;
  label: string;
  files: AssetFile[];
}

export interface SentCall {
  at: string;
  stage: string;
  role: string | null;
  model: string;
  ok: boolean;
  error: string | null;
  seconds: number;
  prompt_chars: number;
  file: string;
  path: string;
}

export interface CarriedSetting {
  id: string;
  label: string;
  section: string;
  value: string;
  reaches: string[];
  misses: string[];
  stored_only: boolean;
}

export interface ProjectAssets {
  groups: AssetGroup[];
  sent: SentCall[];
  carried: { idea: string; settings: CarriedSetting[]; left_to_studio: number };
}

/** What the viewer shows: a file, or a sent call's record (always text). */
export interface Viewed {
  title: string;
  path: string;
  kind: AssetFile['kind'];
}
