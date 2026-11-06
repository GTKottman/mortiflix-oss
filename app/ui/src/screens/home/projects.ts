import type { Mark } from '../../lib/components/StatusMark.svelte';
import { isStageId, stageById, type StageId } from '../../lib/stages';
import { costScreens, costWaitText, isCostWait } from '../../lib/cost-ok';
import type { Group, HomeProject, ProjectChange } from './types';

// The words and rules Home uses about a project: which group it is in, which screen it opens at,
// and what it is waiting for, in plain English.

/** What a stage waits on, after "Waiting for you ". */
const ASK: Partial<Record<StageId, string>> = {
  script: 'to OK the brief or the script',
  voice: 'to OK the voice and music',
  look: 'to pick a look',
  stills: 'to check the stills',
  motion: 'to check the motion',
  sound: 'to check the sound',
  finish: 'to make the video',
};

const ASK_WHY: Partial<Record<StageId, string>> = {
  script: 'Mortiflix wrote the brief or the script. Read it and OK it on Script.',
  voice: 'The lines and the music are ready to hear.',
  look: 'The looks are ready. Pick one and the stills are drawn in it.',
  stills: 'The stills are drawn. Check each one before motion.',
  motion: 'A scene is ready to judge. OK it or send your notes.',
  sound: 'The sounds are placed. Check each shot.',
  finish: 'Every stage is OK. Make the video on Finish and open it in ArtCraft.',
};

/** Why a paused project waits (`needs_you.cause`). */
const CAUSE: Record<string, string> = {
  'gave-up': 'The AI got stuck on this step. Open it to let the AI take over.',
  gpu: 'Waiting for the graphics card to be free.',
  login: 'Claude Code needs you to sign in.',
  billing: 'A paid service ran out of credits.',
  stopped: 'The AI stopped before it finished.',
};

const SCREEN_FOR_STAGE_V3: Record<number, StageId> = {
  0: 'script',
  1: 'voice',
  2: 'look',
  3: 'motion',
  4: 'motion',
  5: 'sound',
  6: 'finish',
};
const SCREEN_FOR_STAGE_OLD: Record<number, StageId> = {
  0: 'script',
  1: 'voice',
  2: 'look',
  3: 'motion',
  4: 'motion',
  5: 'sound',
  6: 'sound',
  7: 'sound',
};

const REASON_MAX = 160;

function stageSetOf(project: HomeProject): string {
  const { pipeline } = project;
  if (pipeline && typeof pipeline === 'object') return pipeline.stage_set || pipeline.slug || '';
  return pipeline || project.set || '';
}

/** The stage the project is at, even once delivered. */
function stageIdOf(project: HomeProject): StageId | undefined {
  const table = stageSetOf(project) === 'v3' ? SCREEN_FOR_STAGE_V3 : SCREEN_FOR_STAGE_OLD;
  return table[project.stage];
}

/** The screen a project opens at: Finish once delivered, else where it stopped. */
export const screenOf = (project: HomeProject): StageId =>
  project.delivered ? 'finish' : (stageIdOf(project) ?? 'script');

/** Where Open leads: the screen with the cost OK while the project waits for one, else `screenOf`. */
export function openScreenOf(project: HomeProject): StageId {
  const need = project.needs_you;
  if (!project.delivered && need && isCostWait(need)) return costScreens(need)[0] ?? screenOf(project);
  return screenOf(project);
}

/** "Open Voice & music ›": the name of the screen Open leads to. */
export const openNameOf = (project: HomeProject): string => stageById(openScreenOf(project)).label;

/** The stage's name as the owner reads it ("Voice & music"). */
export const stageNameOf = (project: HomeProject): string => {
  const id = stageIdOf(project);
  return id && isStageId(id) ? stageById(id).label : 'Script';
};

export const whenOf = (project: HomeProject): string => project.updated_at || project.created_at || '';

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The service's states: draft, queued (working), waiting (for your OK), paused, delivered, cancelled. */
export function groupOf(project: HomeProject): Group {
  if (project.delivered || project.state === 'delivered') return 'done';
  if (project.state === 'waiting' || project.state === 'paused' || project.needs_you) return 'needs';
  return project.state === 'queued' ? 'making' : 'done';
}

export const newestFirst = (list: readonly HomeProject[]): HomeProject[] =>
  // 0 for equal times (MDN: a comparator must be anti-symmetric), so equal projects keep the service's order.
  [...list].sort((a, b) => (whenOf(a) < whenOf(b) ? 1 : whenOf(a) > whenOf(b) ? -1 : 0));

export function splitGroups(list: readonly HomeProject[]): Record<Group, HomeProject[]> {
  const groups: Record<Group, HomeProject[]> = { needs: [], making: [], done: [] };
  for (const project of newestFirst(list)) groups[groupOf(project)].push(project);
  return groups;
}

/** "Waiting for you to pick a look" */
export const waitingText = (project: HomeProject): string =>
  `Waiting for you ${ASK[screenOf(project)] ?? ''}`.trim();

/** One plain sentence on why a project is in "Needs you". */
export function whyText(project: HomeProject): string {
  const need = project.needs_you;
  if (need && isCostWait(need)) return costWaitText(need);
  const cause =
    need && (CAUSE[need.cause ?? ''] || (need.text ? String(need.text).slice(0, REASON_MAX) : ''));
  if (cause) return cause;
  return project.state === 'paused' ? (CAUSE['stopped'] ?? '') : (ASK_WHY[screenOf(project)] ?? '');
}

export type CardMark = { mark: Mark; text: string };

/** The state line on a card in Making or Done and drafts. */
export function cardMark(project: HomeProject): CardMark {
  const stage = stageNameOf(project);
  if (project.delivered) return { mark: 'ok', text: 'Finished' };
  const group = groupOf(project);
  if (group === 'making') return { mark: 'busy', text: `Working on ${stage}` };
  if (group === 'needs') return { mark: 'fix', text: `Waiting at ${stage}` };
  if (project.state === 'draft') return { mark: 'wait', text: 'Draft' };
  if (project.state === 'cancelled') return { mark: 'cut', text: `Stopped at ${stage}` };
  return { mark: 'wait', text: `Stopped at ${stage}` };
}

/** What a card's hover says: the whole title, where the project stands and, when it waits, why. */
export function cardNote(project: HomeProject): string {
  if (groupOf(project) !== 'needs') return `${project.title}\n${cardMark(project).text}`;
  const state = project.state === 'paused' ? 'Paused, needs you' : waitingText(project);
  return [project.title, `${stageNameOf(project)} · ${state}`, whyText(project)].filter(Boolean).join('\n');
}

export const matchesQuery = (project: HomeProject, query: string): boolean =>
  !query.trim() || project.title.toLowerCase().includes(query.trim().toLowerCase());

/** "3 of 9 projects · newest first" while searching, "9 projects · newest first" otherwise. */
export function countLine(total: number, shown: number, query: string): string {
  const searching = query.trim() !== '';
  const plural = (searching ? shown : total) === 1 ? '' : 's';
  return `${searching ? `${shown} of ${total}` : total} project${plural} · newest first`;
}

/** Applies a `project.changed` event to a project in place. */
export function applyChange(project: HomeProject, change: ProjectChange): void {
  project.state = change.state ?? project.state;
  project.stage = change.stage ?? project.stage;
  project.delivered = project.state === 'delivered' || !!change.delivered;
  project.needs_you = change.needs_you ?? null;
}

/** Where a project opens. A plain link, so a new tab works: the app opens ?project= itself. */
export const openHref = (project: HomeProject): string =>
  `${import.meta.env.BASE_URL}?project=${encodeURIComponent(project.id)}#/${openScreenOf(project)}`;
