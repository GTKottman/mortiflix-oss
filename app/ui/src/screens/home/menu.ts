import { STAGES, type StageId } from '../../lib/stages';
import { screenOf } from './projects';
import type { HomeProject } from './types';

// Which actions a project's ⋯ menu offers, and what they send to the service.

export type RunAction = 'pause' | 'resume' | 'stop';

/** The stages a project has reached, in order: it can be opened at any of them. Its own stage is last. */
export function reachedStages(project: HomeProject): StageId[] {
  const here = STAGES.findIndex((stage) => stage.id === screenOf(project));
  return STAGES.slice(0, here + 1)
    .filter((stage) => stage.inLine || stage.id === 'finish')
    .map((stage) => stage.id);
}

/** Pause while it works, Resume once paused or stopped, Stop while it is not finished or stopped. */
export function runActions(project: HomeProject): RunAction[] {
  if (project.delivered || project.state === 'delivered') return [];
  // Stop is not final: a stopped project resumes from where it stopped (service gates.resume)
  if (project.state === 'cancelled') return ['resume'];
  const actions: RunAction[] = [];
  if (project.state === 'queued') actions.push('pause');
  if (project.state === 'paused') actions.push('resume');
  if (project.state !== 'draft') actions.push('stop');
  return actions;
}

export const SERVICE_CALL: Record<RunAction, string> = {
  pause: 'project.pause',
  resume: 'project.resume',
  stop: 'project.cancel',
};

export const ACTION_WORDS: Record<RunAction, { label: string; verb: string }> = {
  pause: { label: 'Pause making', verb: 'pause' },
  resume: { label: 'Resume making', verb: 'resume' },
  stop: { label: 'Stop this project…', verb: 'stop' },
};

/** The project's address, to paste anywhere: it opens at the project's stage. */
export const projectLink = (origin: string, href: string): string => new URL(href, origin).href;

/** What every service call about one project sends: the service reads `project`, not `id`. */
export const projectParams = (project: HomeProject): { project: string } => ({ project: project.id });

export interface DuplicateChoice {
  label: string;
  /** `project.duplicate`'s `upto`: "all" keeps every step the project has OK'd; none = the brief and script. */
  upto?: 'all';
}

/** Steps reached before a copy can carry more than the brief and script (Script, then Voice & music, OK'd). */
const STAGES_BEFORE_MORE = 2;

/** Duplicate always copies the brief and script; once a later step is OK'd it can copy those too. */
export function duplicateChoices(project: HomeProject): DuplicateChoice[] {
  const choices: DuplicateChoice[] = [{ label: 'Duplicate' }];
  if (reachedStages(project).length > STAGES_BEFORE_MORE)
    choices.push({ label: 'Duplicate with every OK’d step', upto: 'all' });
  return choices;
}

/** The project's working folder, relative to the studio (files.reveal takes it as is). */
export const projectFolder = (project: HomeProject): string => `projects/${project.id}`;

/** The longest name `project.rename` keeps. */
export const TITLE_MAX = 120;

/** A name the owner typed, tidied the way the service keeps it; "" when there is nothing to save. */
export const cleanTitle = (typed: string): string => typed.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
