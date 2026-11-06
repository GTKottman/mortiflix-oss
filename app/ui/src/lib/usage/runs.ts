// The token viewer's data (owner 2026-10-18: "list token usage … poke through the process and token-optimize the
// pipeline"; the old app's Token Tracker, crates/mortiflix-ui/src/tokens.rs). The service reads the transcripts:
// `tokens.runs` (every Claude run of the project, newest first, and what the voice used) and `tokens.run` (one run's
// calls grouped by what they did, and what was pulled into the context). See docs/service-protocol.md.
// Hostile answers: a missing or wrong field becomes 0, '' or an empty list, never a crash.
import { compactCount } from './format';
import { count, field, isObject, list, text, type Loose } from './normalize';

export interface ModelUse {
  model: string;
  calls: number;
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  total: number;
}

export interface TokenRun extends Omit<ModelUse, 'model'> {
  id: string;
  started: string | null;
  running: boolean;
  backend: string;
  model: string;
  why: string;
  models: ModelUse[];
}

export interface TokenBar extends Omit<ModelUse, 'model'> {
  key: string;
  examples: { label: string; times: number }[];
  why: string;
  models: string[];
}

export interface Pulled {
  label: string;
  group: string;
  from: string;
  tokens: number;
  calls_after: number;
  carried: number;
}

export interface RunDetail {
  run: TokenRun;
  bars: TokenBar[];
  pulled: Pulled[];
}

/** What the voice used: ElevenLabs characters, or this computer's lines and time. */
export interface VoiceUse {
  engine: string;
  voice: string;
  model: string;
  characters: number;
  lines: number;
  recordings: number;
  seconds: number;
  last: string | null;
}

const split = (raw: Loose) => ({
  calls: count(raw.calls),
  input: count(raw.input),
  cache_write: count(raw.cache_write),
  cache_read: count(raw.cache_read),
  output: count(raw.output),
  total: count(raw.total),
});

const modelUse = (raw: Loose): ModelUse => ({ model: text(raw.model), ...split(raw) });

function tokenRun(raw: Loose): TokenRun {
  return {
    id: text(raw.id),
    started: text(raw.started) || null,
    running: raw.running === true,
    backend: text(raw.backend),
    model: text(raw.model),
    why: text(raw.why),
    models: list(raw.models).map(modelUse),
    ...split(raw),
  };
}

/** `tokens.runs` -> the runs and the voice (at most 8 voices, as the old app showed). */
export function readRuns(raw: unknown): { runs: TokenRun[]; voice: VoiceUse[] } {
  const r = isObject(raw) ? raw : {};
  return {
    runs: list(r.runs).map(tokenRun).filter((run) => run.id),
    voice: list(r.voice)
      .slice(0, 8)
      .map((v) => ({
        engine: text(v.engine),
        voice: text(v.voice),
        model: text(v.model),
        characters: count(v.characters),
        lines: count(v.lines),
        recordings: count(v.recordings),
        seconds: count(v.seconds),
        last: text(v.last) || null,
      })),
  };
}

/** `tokens.run` -> one run's bars and what it pulled in. */
export function readDetail(raw: unknown): RunDetail {
  const r = isObject(raw) ? raw : {};
  return {
    run: tokenRun(field(r, 'run')),
    bars: list(r.bars).map((b) => ({
      key: text(b.key),
      examples: list(b.examples).map((e) => ({ label: text(e.label), times: count(e.times) })),
      why: text(b.why),
      models: Array.isArray(b.models) ? b.models.filter((m): m is string => typeof m === 'string') : [],
      ...split(b),
    })),
    pulled: list(r.pulled).map((p) => ({
      label: text(p.label),
      group: text(p.group),
      from: text(p.from),
      tokens: count(p.tokens),
      calls_after: count(p.calls_after),
      carried: count(p.carried),
    })),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A run's ISO start in local time: "17 Oct, 4:39 pm". Unknown -> ''. */
export function when(iso: string | null): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const h = at.getHours();
  const clock = `${h % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}, ${clock}`;
}

/** "Input 120 · cache 7.5M (written 210k, re-read 7.3M) · output 80k". */
export const splitText = (u: Omit<ModelUse, 'model'>): string =>
  `Input ${compactCount(u.input)} · cache ${compactCount(u.cache_write + u.cache_read)} (written ${compactCount(u.cache_write)}, re-read ${compactCount(u.cache_read)}) · output ${compactCount(u.output)}`;

/** "Opus 5.5 237k · Sonnet 5.5 80k": each model with its tokens, biggest first (the service sorts them). */
export const modelsLine = (models: readonly ModelUse[]): string =>
  models.map((m) => `${m.model} ${compactCount(m.total)}`).join(' · ');

/** What the voice used, in the old app's three lines. */
export function voiceLines(v: VoiceUse): { name: string; amount: string; how: string } {
  const eleven = v.engine === 'elevenlabs';
  const who = [v.voice, eleven && v.model ? `(${v.model})` : v.model].filter(Boolean).join(' ');
  const name = eleven ? 'ElevenLabs' : 'This computer';
  const amount = eleven
    ? `${v.characters} characters`
    : `${Math.floor(v.seconds / 60)}:${String(Math.floor(v.seconds % 60)).padStart(2, '0')} of work`;
  const how = eleven ? 'online, billed by characters' : 'local voice model, nothing to pay';
  return {
    name: who ? `${name} · ${who}` : name,
    amount: `Voice: ${amount} · ${v.lines} lines, ${v.recordings} recordings`,
    how: `${how}${v.last ? ` · last ${when(v.last)}` : ''}`,
  };
}
