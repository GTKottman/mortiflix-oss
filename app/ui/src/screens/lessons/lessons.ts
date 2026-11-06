import { plural } from '../../lib/words';
import type { Lesson } from './types';

// The rules Lessons uses to filter, count and word its list.

export const SECTIONS = ['Process', 'Design', 'Motion', 'Picture and words', 'Sound', 'Characters'] as const;
export const ALL = 'All';
export const PAGE = 8;
/** "Show more" adds this many pages at once. */
export const MORE_PAGES = 4;

export type SectionFilter = typeof ALL | string;
export type ScopeFilter = 'all' | 'every' | 'project';
export type StatusFilter = 'new' | 'on' | 'off';

export interface Filters {
  section: SectionFilter;
  scope: ScopeFilter;
  status: StatusFilter | null;
  query: string;
}

export const NO_FILTERS: Filters = { section: ALL, scope: 'all', status: null, query: '' };

export const isWaiting = (lesson: Lesson): boolean => !lesson.approved;
export const isOn = (lesson: Lesson): boolean => lesson.approved && lesson.on;
/** Approved, then switched off. */
export const isOff = (lesson: Lesson): boolean => lesson.approved && !lesson.on;

/** The note or picture behind a lesson, so there is something to show under Note. */
export const hasNote = (lesson: Lesson): boolean => !!(lesson.source?.note || lesson.source?.image);

const STATUS_TEST: Record<StatusFilter, (lesson: Lesson) => boolean> = {
  new: isWaiting,
  on: isOn,
  off: isOff,
};

export function visibleLessons(lessons: readonly Lesson[], filters: Filters): Lesson[] {
  const query = filters.query.toLowerCase();
  return lessons.filter(
    (lesson) =>
      (filters.section === ALL || lesson.section === filters.section) &&
      (filters.scope === 'all' ||
        (filters.scope === 'every' ? lesson.scope === 'all' : lesson.scope === 'project')) &&
      (!filters.status || STATUS_TEST[filters.status](lesson)) &&
      (!query ||
        `${lesson.name ?? ''} ${lesson.text} ${lesson.source?.note ?? ''} ${sourceProject(lesson)}`.toLowerCase().includes(query)),
  );
}

export interface Totals {
  total: number;
  waiting: number;
  on: number;
  off: number;
}

export const totalsOf = (lessons: readonly Lesson[]): Totals => ({
  total: lessons.length,
  waiting: lessons.filter(isWaiting).length,
  on: lessons.filter(isOn).length,
  off: lessons.filter(isOff).length,
});

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const NOTE_CLIP = 140;
const NAME_CLIP = 60;

/** What a lesson is called: its name, or the start of its words when it has none. */
export const lessonName = (lesson: Pick<Lesson, 'name' | 'text'>): string =>
  lesson.name || clip(lesson.text, NAME_CLIP);

/** The name of the project a lesson's note came from ("" when none). */
export const sourceProject = (lesson: Lesson): string =>
  lesson.source?.project_title ?? lesson.source?.project ?? '';

/** Where a lesson came from, in one line: project · scene · your note · used in N scenes. */
export function sourceLine(lesson: Lesson): string {
  const source = lesson.source ?? {};
  const bits: string[] = [];
  if (sourceProject(lesson)) bits.push(sourceProject(lesson));
  if (source.node) bits.push(`scene ${String(source.node).toUpperCase()}`);
  if (source.note) bits.push(`your note: “${clip(source.note, NOTE_CLIP)}”`);
  if (lesson.approved && lesson.used > 0) bits.push(`used in ${plural(lesson.used, 'scene')}`);
  if (lesson.scope === 'project') bits.push('only this project');
  return bits.join(' · ');
}

/** The words under a marked frame: “the note” · frame 12 · project · S02. */
export function noteLine(lesson: Lesson): string {
  const source = lesson.source ?? {};
  if (!source.note) return '';
  const where = [
    source.frame != null ? `frame ${source.frame}` : null,
    sourceProject(lesson) || null,
    source.node ? String(source.node).toUpperCase() : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `“${source.note}”${where ? ` · ${where}` : ''}`;
}

export const scopeLabel = (project: string): string => (project ? `Only ${project}` : 'Only this project');

const STATUS_LABEL: Record<StatusFilter, string> = { new: 'Waiting for you', on: 'On', off: 'Off' };

/** What is filtered right now, for the "Showing …" line. */
export function activeFilters(filters: Filters, project: string): string[] {
  const names: (string | null)[] = [
    filters.section !== ALL ? filters.section : null,
    filters.scope === 'all' ? null : filters.scope === 'every' ? 'Every project' : scopeLabel(project),
    filters.status ? STATUS_LABEL[filters.status] : null,
    filters.query.trim() ? `“${filters.query.trim()}”` : null,
  ];
  return names.filter((name): name is string => name !== null);
}

/**
 * A lesson the owner just decided keeps its place, so its Undo does not jump away when the service moves it.
 * `pinned` maps a lesson id to the place it had.
 */
export function placePinned(rows: readonly Lesson[], pinned: ReadonlyMap<string, number>): Lesson[] {
  const placed = [...rows];
  for (const [id, at] of pinned) {
    const from = placed.findIndex((lesson) => lesson.id === id);
    const [lesson] = from > -1 && at >= 0 && at < from ? placed.splice(from, 1) : [];
    if (lesson) placed.splice(at, 0, lesson);
  }
  return placed;
}

/** One button of the filter rail. */
export interface Choice<Id extends string = string> {
  id: Id;
  label: string;
  count: number;
  selected: boolean;
}
