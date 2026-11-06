import { SvelteMap } from 'svelte/reactivity';
import type { ReviewService } from '../../lib/review/types';
import { isNotBuiltYet, type ServiceClient } from '../../lib/service/client';
import {
  NO_FILTERS,
  PAGE,
  MORE_PAGES,
  placePinned,
  totalsOf,
  visibleLessons,
  type Filters,
  type ScopeFilter,
  type SectionFilter,
  type StatusFilter,
} from './lessons';
import type { Lesson, LessonScope, LessonsAnswer } from './types';

// What Lessons shows and what the owner has done on it: the list, the filters, the card being edited,
// the lessons just decided (pinned so Undo stays put) and the one just switched off.

export type Phase = 'loading' | 'ok' | 'soon' | 'error';

type Client = Pick<ServiceClient, 'call'>;

export class LessonsView {
  lessons = $state<Lesson[]>([]);
  phase = $state<Phase>('loading');
  error = $state('');
  filters = $state<Filters>({ ...NO_FILTERS });
  shown = $state(PAGE);
  editing = $state<string | null>(null);
  noteOpen = $state<string | null>(null);
  /** Lessons decided this visit, by id, with the place they had in the list. */
  pinned = new SvelteMap<string, number>();
  /** The lesson just switched off: it offers Undo. */
  offId = $state<string | null>(null);
  /** The owner has decided at least one lesson this visit. */
  decided = $state(false);
  /** The lesson just deleted: it offers Undo. */
  removed = $state<Lesson | null>(null);
  /** A failed switch, in words. Cleared by the next action. */
  notice = $state<string | null>(null);
  /** What a waiting lesson's decision talks to, when it is not the app's service (the screenshot fixture). */
  decisions: ReviewService | null = null;
  /** The service changed the list while the owner was in the middle of something. */
  #stale = false;
  /** The notice a failed reload put up, so the next good read takes it down again. */
  #reloadNotice: string | null = null;
  readonly #toggling = new Set<string>();
  readonly #client: Client;
  readonly #ready: () => Promise<void>;

  /** `ready` resolves once the open project is known, so the list is for the right project. */
  constructor(client: Client, ready: () => Promise<void> = () => Promise.resolve()) {
    this.#client = client;
    this.#ready = ready;
  }

  readonly rows = $derived(placePinned(visibleLessons(this.lessons, this.filters), this.pinned));
  readonly totals = $derived(totalsOf(this.lessons));
  readonly visible = $derived(this.rows.slice(0, this.shown));
  readonly hidden = $derived(Math.max(0, this.rows.length - this.shown));
  /** How many lessons the next Show more adds. */
  readonly more = $derived(Math.min(this.hidden, PAGE * MORE_PAGES));

  async load(): Promise<void> {
    this.#stale = false;
    try {
      await this.#ready();
      const answer = await this.#client.call<LessonsAnswer>('lessons.list', { scope: 'both' });
      this.lessons = answer.lessons;
      this.phase = 'ok';
      this.error = '';
      if (this.notice === this.#reloadNotice) this.notice = null;
    } catch (error) {
      // The list is on screen already (a reload after Save, Delete, a live change): keep it and say it may be old,
      // so a write that worked never turns into a full-screen error.
      if (this.phase === 'ok') {
        this.#reloadNotice = `The list could not be read again: ${error instanceof Error ? error.message : 'unknown error'}. It may be out of date.`;
        this.notice = this.#reloadNotice;
        return;
      }
      if (isNotBuiltYet(error)) this.phase = 'soon';
      else {
        this.phase = 'error';
        this.error = error instanceof Error ? error.message : 'unknown error';
      }
    }
  }

  /** The service says lessons changed. Waits while a card is being edited or just decided. */
  changed(): void {
    if (this.pinned.size || this.editing) this.#stale = true;
    else void this.load();
  }

  /** Cancel on an edit: a live change that waited for the edit to end is read now. */
  stopEditing(): void {
    this.editing = null;
    if (this.#stale && !this.pinned.size) void this.load();
  }

  showMore(): void {
    this.shown += PAGE * MORE_PAGES;
  }

  setSection(section: SectionFilter): void {
    this.#refilter({ section });
  }

  setScope(scope: ScopeFilter): void {
    this.#refilter({ scope });
  }

  setStatus(status: StatusFilter | null): void {
    this.#refilter({ status });
  }

  setQuery(query: string): void {
    this.filters.query = query;
    this.shown = PAGE;
  }

  clearFilters(): void {
    this.#refilter({ ...NO_FILTERS });
  }

  #refilter(change: Partial<Filters>): void {
    this.filters = { ...this.filters, ...change };
    this.shown = PAGE;
    this.pinned.clear();
    this.offId = null;
    this.removed = null;
    this.notice = null;
    if (this.#stale) void this.load();
  }

  /**
   * After a decision: read the list quietly and keep the decided card where it was, so its Undo stays visible.
   * A lesson that is no longer on (undone, or deleted) goes back to its normal place.
   */
  async decide(lesson: Lesson): Promise<void> {
    const at = this.rows.findIndex((row) => row.id === lesson.id);
    let answer: LessonsAnswer;
    try {
      answer = await this.#client.call<LessonsAnswer>('lessons.list', { scope: 'both' });
    } catch (error) {
      this.notice = `Saved, but the list could not be read again: ${error instanceof Error ? error.message : 'unknown error'}`;
      return;
    }
    this.lessons = answer.lessons;
    this.phase = 'ok';
    this.decided = true;
    const now = answer.lessons.find((l) => l.id === lesson.id);
    if (now?.on) this.pinned.set(lesson.id, at);
    else this.pinned.delete(lesson.id);
  }

  async toggle(lesson: Lesson, on: boolean): Promise<void> {
    // One switch at a time per lesson: a quick second flip waits for the first answer instead of racing it.
    if (this.#toggling.has(lesson.id)) return;
    this.#toggling.add(lesson.id);
    this.notice = null;
    try {
      await this.#client.call('lessons.toggle', { id: lesson.id, on });
    } catch (error) {
      this.notice = `Could not save that: ${error instanceof Error ? error.message : 'unknown error'}`;
      return;
    } finally {
      this.#toggling.delete(lesson.id);
    }
    this.offId = on ? null : lesson.id;
    lesson.on = on;
  }

  async save(lesson: Lesson, text: string, section: string, name?: string): Promise<void> {
    const words = text.trim();
    if (!words) throw new Error('the lesson has no words; write it or press Cancel');
    await this.#client.call('lessons.edit', {
      id: lesson.id,
      text: words,
      section,
      ...(name === undefined ? {} : { name: name.trim() }),
    });
    this.editing = null;
    // A just-decided card that was edited goes back to its normal row: its decision buttons are done.
    this.pinned.delete(lesson.id);
    await this.load();
  }

  /** Every project, or only the project its note came from. */
  async moveScope(lesson: Lesson, scope: LessonScope): Promise<void> {
    await this.#client.call('lessons.edit', { id: lesson.id, scope });
    this.pinned.delete(lesson.id);
    await this.load();
  }

  /** Deletes it; the service keeps it, so Undo can bring it back. */
  async remove(lesson: Lesson): Promise<void> {
    await this.#client.call('lessons.delete', { id: lesson.id });
    this.editing = null;
    this.pinned.delete(lesson.id);
    this.removed = lesson;
    await this.load();
  }

  async undoRemove(): Promise<void> {
    const lesson = this.removed;
    if (!lesson) return;
    this.notice = null;
    try {
      await this.#client.call('lessons.restore', { id: lesson.id });
    } catch (error) {
      this.notice = `Could not bring the lesson back: ${error instanceof Error ? error.message : 'unknown error'}`;
      return;
    }
    this.removed = null;
    await this.load();
  }

  toggleNote(id: string): void {
    this.noteOpen = this.noteOpen === id ? null : id;
  }
}
