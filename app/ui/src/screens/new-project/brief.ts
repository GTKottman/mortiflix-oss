import { pad2 } from '../../lib/time';
import { plural } from '../../lib/words';
import type {
  Choice,
  Conflict,
  DecideKey,
  DecideLater,
  SchemaField,
  SchemaSection,
  Settings,
  Value,
} from './types';

// The brief is sparse: only what the owner touched is in it. Absent = default, Reset = delete the key
// (contract: "The service never writes defaults into the brief"). Every function here returns new objects.

export const DECIDE_KEYS: readonly DecideKey[] = ['voice', 'music', 'sound_design', 'pauses'];

const isRecord = (value: Value | undefined): value is { [key: string]: Value } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const same = (a: Value | undefined, b: Value | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

/** "story.tone" -> ["story", "tone"]; the key keeps any later dots. */
export function splitPath(path: string): [section: string, key: string] {
  const at = path.indexOf('.');
  return [path.slice(0, at), path.slice(at + 1)];
}

export function rawValue(settings: Settings, path: string): Value | undefined {
  const [section, key] = splitPath(path);
  return settings[section]?.[key];
}

export const isSet = (settings: Settings, path: string): boolean => rawValue(settings, path) !== undefined;

/** What the field is now: the default, with the owner's parts on top for object fields. */
export function valueOf(field: SchemaField, settings: Settings): Value {
  const raw = rawValue(settings, field.id);
  if (field.type === 'object')
    return { ...(isRecord(field.default) ? field.default : {}), ...(isRecord(raw) ? raw : {}) };
  return raw === undefined ? field.default : raw;
}

export function partValue(field: SchemaField, settings: Settings, part: string): Value {
  const value = valueOf(field, settings);
  return (isRecord(value) ? value[part] : undefined) ?? null;
}

/** Drops what equals the default, so a setting put back to its default leaves the brief. */
function tidy(field: SchemaField, value: Value): Value | undefined {
  if (field.type !== 'object' || !isRecord(value)) return same(value, field.default) ? undefined : value;
  const defaults = isRecord(field.default) ? field.default : {};
  const kept = Object.fromEntries(Object.entries(value).filter(([part, x]) => !same(x, defaults[part])));
  return Object.keys(kept).length ? kept : undefined;
}

function write(settings: Settings, field: SchemaField, value: Value | undefined): Settings {
  const [section, key] = splitPath(field.id);
  const tidied = value === undefined ? undefined : tidy(field, value);
  const others = Object.entries(settings[section] ?? {}).filter(([k]) => k !== key);
  const sectionValues = Object.fromEntries(tidied === undefined ? others : [...others, [key, tidied]]);
  const rest = Object.entries(settings).filter(([name]) => name !== section);
  return Object.fromEntries(Object.keys(sectionValues).length ? [...rest, [section, sectionValues]] : rest);
}

export const setValue = (settings: Settings, field: SchemaField, value: Value): Settings =>
  write(settings, field, value);

/** Sets some parts of an object field and keeps the others as they are. */
export function setParts(settings: Settings, field: SchemaField, parts: { [part: string]: Value }): Settings {
  const raw = rawValue(settings, field.id);
  return write(settings, field, { ...(isRecord(raw) ? raw : {}), ...parts });
}

export const resetField = (settings: Settings, field: SchemaField): Settings =>
  write(settings, field, undefined);

/** Reset this section: every setting in it except the quick ones, which live above the accordions. */
export function resetSection(settings: Settings, section: SchemaSection, quick: readonly string[]): Settings {
  return section.fields
    .filter((field) => !quick.includes(field.id))
    .reduce((next, field) => resetField(next, field), settings);
}

/** Sets a setting by path from a conflict fix, a suggestion or a preset; a path the schema does not know is ignored. */
export function setByPath(
  settings: Settings,
  fields: Readonly<Record<string, SchemaField>>,
  path: string,
  value: Value,
): Settings {
  const field = fields[path];
  if (!field) return settings;
  return field.type === 'object' && isRecord(value)
    ? setParts(settings, field, value)
    : setValue(settings, field, value);
}

const NOT_SETTINGS = ['version', 'idea', 'title', 'sources', 'meta', 'decide_later'];

/** Applies a preset or template: its settings go on top of the owner's. Idea, title and sources are never touched. */
export function applyPreset(
  settings: Settings,
  fields: Readonly<Record<string, SchemaField>>,
  preset: { [key: string]: Value },
): Settings {
  let next = settings;
  for (const [section, values] of Object.entries(preset)) {
    if (NOT_SETTINGS.includes(section) || !isRecord(values)) continue;
    for (const [key, value] of Object.entries(values))
      next = setByPath(next, fields, `${section}.${key}`, value);
  }
  return next;
}

/** Choosing a voice, music, sound or pause setting means it is no longer "decide later". */
export function withoutDecided(decideLater: DecideLater | null, path: string): DecideLater | null {
  const key = DECIDE_KEYS.find((k) => path === `voice.${k}`);
  if (!key || !decideLater) return decideLater;
  const rest = Object.fromEntries(Object.entries(decideLater).filter(([k]) => k !== key));
  return Object.keys(rest).length ? rest : null;
}

export interface BriefParts {
  idea: string;
  title: string;
  settings: Settings;
  decideLater: DecideLater | null;
  suggested: string[];
  sourceIds: string[];
}

/** The brief as the service reads it (contract object, version 1). */
export function toContract(parts: BriefParts): Record<string, Value> {
  const brief: Record<string, Value> = { version: 1 };
  if (parts.idea) brief['idea'] = parts.idea;
  if (parts.title) brief['title'] = parts.title;
  if (parts.sourceIds.length) brief['sources'] = parts.sourceIds;
  Object.assign(brief, parts.settings);
  if (parts.decideLater) brief['decide_later'] = { ...parts.decideLater } as Value;
  if (parts.suggested.length) brief['meta'] = { suggested: parts.suggested };
  return brief;
}

/** The other way: a saved draft or backup back into the screen's pieces. Sources come from the tray, not the brief. */
export function fromContract(brief: { [key: string]: Value }): Omit<BriefParts, 'sourceIds'> {
  const settings: Settings = {};
  for (const [section, values] of Object.entries(brief)) {
    if (!NOT_SETTINGS.includes(section) && isRecord(values)) settings[section] = values;
  }
  const decide = brief['decide_later'];
  const meta = brief['meta'];
  const suggested = isRecord(meta) && Array.isArray(meta['suggested']) ? meta['suggested'] : [];
  return {
    idea: typeof brief['idea'] === 'string' ? brief['idea'] : '',
    title: typeof brief['title'] === 'string' ? brief['title'] : '',
    settings,
    decideLater: isRecord(decide) ? (decide as DecideLater) : null,
    suggested: suggested.filter((x): x is string => typeof x === 'string'),
  };
}

/** True when the brief holds anything worth keeping (an idea, a setting, a source). */
export const hasContent = (parts: BriefParts): boolean =>
  Boolean(parts.idea) ||
  Object.keys(parts.settings).length > 0 ||
  parts.sourceIds.length > 0 ||
  Boolean(parts.title);

// ---- words on screen ----

const PART_WORDS: Record<string, string> = {
  rights_confirmed: 'I have the rights to the files I add',
  heading_font: 'Heading font',
  body_font: 'Body font',
  logo_source: 'Logo (file name or link)',
  narrative_pauses: 'Pauses between lines',
  precedence: 'When both fit, use first',
  fps: 'Frame rate',
};

/** The label of one part of an object field, e.g. "narrative_pauses" -> "Pauses between lines". */
export const partLabel = (key: string): string =>
  PART_WORDS[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');

export const choiceLabel = (choices: readonly Choice[] | undefined, value: Value): string =>
  (choices ?? []).find((c) => c.value === value)?.label ?? String(value);

/** One short phrase for what the owner set in a field, shown in the closed accordion. */
export function shortValue(field: SchemaField, settings: Settings): string {
  const value = valueOf(field, settings);
  if (field.type === 'choice') return choiceLabel(field.choices, value);
  if (field.type === 'multi' && Array.isArray(value))
    return value.map((x) => choiceLabel(field.choices, x)).join(', ');
  if (field.type === 'object') {
    const raw = rawValue(settings, field.id);
    const words = isRecord(raw)
      ? Object.entries(raw).map(([key, x]) => {
          if (typeof x !== 'string') return field.label;
          const choices = field.parts?.find((p) => p.key === key)?.choices;
          return choices ? choiceLabel(choices, x) : x;
        })
      : [];
    return words.filter(Boolean).slice(0, 2).join(', ') || field.label;
  }
  if (field.type === 'list') return `${field.label} (${Array.isArray(value) ? value.length : 0})`;
  return String(value).slice(0, 28);
}

/** The accordion header: what is set in it, and how many conflicts touch it. */
export function sectionHeader(
  section: SchemaSection,
  settings: Settings,
  quick: readonly string[],
  conflicts: readonly Conflict[],
  decideLater: DecideLater | null,
): { summary: string; count: string; conflicted: boolean } {
  const set = section.fields.filter((f) => !quick.includes(f.id) && isSet(settings, f.id));
  const touching = conflicts.filter((c) =>
    c.paths.some((p) => p.split('.')[0] === section.id && !quick.includes(p)),
  ).length;
  const deciding = section.id === 'voice' && (decideLater !== null || set.length === 0);
  const summary = deciding
    ? 'Decide later: voice and music are chosen in Voice & music'
    : set.length
      ? set
          .slice(0, 4)
          .map((f) => shortValue(f, settings))
          .join(' · ')
      : 'Defaults';
  const count = touching ? `! ${plural(touching, 'conflict')}` : set.length ? `${set.length} customized` : '';
  return { summary, count, conflicted: touching > 0 };
}

/** The conflicts to show at one control: those with a path inside it ("delivery.duration.seconds" is in "delivery.duration"). */
export const conflictsAt = (conflicts: readonly Conflict[], path: string): Conflict[] =>
  conflicts.filter((c) => c.paths.some((p) => p === path || p.split('.').slice(0, 2).join('.') === path));

// ---- length ----

export const WORDS_PER_MINUTE: Record<string, number> = { slow: 120, natural: 150, brisk: 180 };
/** Spoken words fill nine tenths of a video; the rest is pauses and breaths (the service's brief summary agrees). */
const SPOKEN_SHARE = 0.9;
const SECONDS_PER_SCENE = 8;

/** The pace the voice settings ask for, "natural" when none is set. */
export function pacingOf(fields: Record<string, SchemaField>, settings: Settings): string {
  const voice = fields['voice.voice'];
  const value = voice ? valueOf(voice, settings) : null;
  const pacing = isRecord(value) ? value['pacing'] : undefined;
  return typeof pacing === 'string' && pacing in WORDS_PER_MINUTE ? pacing : 'natural';
}

/** The one spoken-word estimate for a length: the Length box and the brief card both show this number. */
export const spokenWordsAbout = (seconds: number, pacing: string): number =>
  Math.round(
    (seconds / 60) * (WORDS_PER_MINUTE[pacing] ?? WORDS_PER_MINUTE['natural'] ?? 150) * SPOKEN_SHARE,
  );

export const scenesAbout = (seconds: number): number => Math.max(1, Math.round(seconds / SECONDS_PER_SCENE));

/** What each destination usually uses; only a suggestion. */
export const RECOMMENDED_SHAPE: Record<string, string> = {
  youtube: '16:9',
  tiktok: '9:16',
  reels: '9:16',
  presentation: '16:9',
  website: '16:9',
};

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds % 60) return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
  return `${seconds / 60} min`;
}

export const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
