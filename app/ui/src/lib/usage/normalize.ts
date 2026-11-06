import type {
  ClaudeTokens,
  ElevenLabsBalance,
  Usage,
  UsageDay,
  UsageGroup,
  UsageRange,
  UsageRecords,
} from './types';

// Turns the service's `usage.get` answer into a complete Usage: missing numbers become 0, missing lists empty,
// ids become names (project titles, stage labels, model names). The panel then never checks for holes.

export type Loose = Record<string, unknown>;

/** Names for ids the answer carries: project id -> title, stage id -> label. */
export interface UsageNames {
  projects?: ReadonlyMap<string, string>;
  stages?: ReadonlyMap<string, string>;
}

/** Project id -> title, from `project.list`. */
export const projectTitles = (
  projects: readonly { id: string; title?: string }[],
): ReadonlyMap<string, string> => new Map(projects.map((p) => [p.id, p.title ?? p.id]));

export const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null;
export const field = (value: unknown, key: string): Loose => {
  const inner = isObject(value) ? value[key] : undefined;
  return isObject(inner) ? inner : {};
};
export const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const list = (value: unknown): Loose[] => (Array.isArray(value) ? value.filter(isObject) : []);

function claudeTokens(raw: Loose): ClaudeTokens {
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  const cache_read = count(raw.cache_read_tokens);
  const cache_write = count(raw.cache_write_tokens);
  return {
    input,
    output,
    cache_read,
    cache_write,
    total: count(raw.total_tokens) || input + output + cache_read + cache_write,
    calls: count(raw.calls),
  };
}

/**
 * "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-20250514" -> "Sonnet 4", "claude-3-5-sonnet-20241022" ->
 * "Sonnet 3.5", "eleven_v4" -> "ElevenLabs v4". Unknown names stay as they are.
 * Model ids before the 4.6 generation end in a snapshot date (platform.claude.com models overview): a version part
 * is one or two digits, so the 8-digit date is never read as a minor version.
 */
export function modelName(model: string): string {
  const named = (family: string, major: string | undefined, minor: string | undefined): string =>
    `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major ?? ''}${minor ? `.${minor}` : ''}`;
  const claude = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2})(?!\d))?(?!\d)/.exec(model);
  if (claude) return named(claude[1] ?? '', claude[2], claude[3]);
  const legacy = /^claude-(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)/.exec(model);
  if (legacy) return named(legacy[3] ?? '', legacy[1], legacy[2]);
  const eleven = /^eleven_(.+)$/.exec(model);
  if (eleven) return `ElevenLabs ${(eleven[1] ?? '').replace(/_/g, ' ')}`;
  return model;
}

/** A project id without its title: "261023-black-october-the-cves-fa2f" -> "Black october the cves". */
export function projectNameFromId(id: string): string {
  const words = id
    .replace(/^\d{6}-/, '')
    .replace(/-[0-9a-f]{4}$/, '')
    .replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const projectLabel = (id: string, names: UsageNames): string =>
  id ? (names.projects?.get(id) ?? projectNameFromId(id)) : 'No project';
/** A stage the app has no name for still reads as words: "render" -> "Render", "colourGrade" -> "Colour grade". */
function stageLabel(id: string, names: UsageNames): string {
  if (!id) return 'No stage';
  const known = names.stages?.get(id);
  if (known) return known;
  const words = id
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Rows with the same name become one ("voice" and "voiceMusic" are both Voice & music), in the service's order. */
export function mergeByLabel(groups: readonly UsageGroup[]): UsageGroup[] {
  const merged = new Map<string, UsageGroup>();
  for (const g of groups) {
    const seen = merged.get(g.label);
    if (!seen) merged.set(g.label, { ...g });
    else {
      seen.claude_tokens += g.claude_tokens;
      seen.elevenlabs_credits += g.elevenlabs_credits;
    }
  }
  return [...merged.values()];
}

function group(raw: Loose, key: string, label: string): UsageGroup {
  return {
    key,
    label,
    claude_tokens: claudeTokens(field(raw, 'claude')).total,
    elevenlabs_credits: count(field(raw, 'elevenlabs').credits),
  };
}

function day(raw: Loose): UsageDay {
  return {
    date: text(raw.date),
    claude_tokens: claudeTokens(field(raw, 'claude')).total,
    elevenlabs_credits: count(field(raw, 'elevenlabs').credits),
  };
}

function balance(raw: unknown): ElevenLabsBalance | null {
  if (!isObject(raw)) return null;
  return {
    remaining: count(raw.remaining),
    limit: count(raw.limit),
    resets_at: text(raw.resets_at),
    stale: raw.stale === true,
  };
}

function records(raw: Loose, names: UsageNames): UsageRecords {
  const bigDay = field(field(raw, 'biggest_day'), 'claude');
  const bigProject = field(field(raw, 'biggest_project'), 'claude');
  const call = field(field(raw, 'biggest_call'), 'claude');
  const streak = field(raw, 'longest_streak');
  const callTokens = claudeTokens(call).total;
  const dayTokens = claudeTokens(field(bigDay, 'claude')).total;
  const projectTokens = claudeTokens(field(bigProject, 'claude')).total;
  const projectId = text(bigProject.project);
  return {
    biggest_day: dayTokens ? { date: text(bigDay.date), claude_tokens: dayTokens } : null,
    biggest_project: projectTokens
      ? { key: projectId, label: projectLabel(projectId, names), claude_tokens: projectTokens }
      : null,
    biggest_call: callTokens
      ? {
          at: text(call.at),
          claude_tokens: callTokens,
          model: modelName(text(call.model)),
          stage: text(call.stage) ? stageLabel(text(call.stage), names) : '',
        }
      : null,
    streak: { longest: count(streak.days), current: count(streak.current) },
  };
}

export function normalizeUsage(
  raw: unknown,
  range: UsageRange,
  project: string | null,
  names: UsageNames = {},
): Usage {
  const data = isObject(raw) ? raw : {};
  const totals = field(data, 'totals');
  const eleven = field(totals, 'elevenlabs');
  return {
    range,
    project,
    totals: {
      claude: claudeTokens(field(totals, 'claude')),
      elevenlabs: { credits: count(eleven.credits), calls: count(eleven.calls) },
    },
    by_project: list(data.by_project).map((g) =>
      group(g, text(g.project), projectLabel(text(g.project), names)),
    ),
    by_stage: mergeByLabel(
      list(data.by_stage).map((g) => group(g, text(g.stage), stageLabel(text(g.stage), names))),
    ),
    by_model: mergeByLabel(
      list(data.by_model).map((g) =>
        group(g, `${text(g.provider)}:${text(g.kind)}:${text(g.model)}`, modelName(text(g.model)) || text(g.kind)),
      ),
    ),
    series: list(data.series).map(day),
    records: records(field(data, 'records'), names),
    elevenlabs: balance(data.elevenlabs_balance),
    elevenlabs_why: text(data.elevenlabs_balance_why),
  };
}
