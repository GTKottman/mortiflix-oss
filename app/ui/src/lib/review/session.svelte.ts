import type { Problems } from '../stores/problems.svelte';
import { plural } from '../words';
import type { DecisionResult, ReviewItem, ReviewService } from './types';

// One review session: which piece is on view, which version, what is being sent, and the OK / Fix
// calls. Look and Stills differ only in the service's names (`frames.ok` / `stills.ok`) and the parameter.

interface Config {
  service: ReviewService;
  problems: Problems;
  /** 'frames' | 'stills': the prefix of the service calls. */
  calls: 'frames' | 'stills';
  /** The service's parameter name for the piece: 'frame' | 'line'. */
  param: 'frame' | 'line';
  /** Problem id in the Fix it strip. */
  problemId: string;
  /** Loads the screen's data again after every action. */
  reload: () => Promise<void>;
  /** The words shown where the picture goes while the next piece is made, after an OK. */
  afterOk: (item: ReviewItem, result: DecisionResult | undefined) => string;
}

/** A piece the owner can decide on: one in review, or one held with a check not satisfied. */
export const decidable = (item: ReviewItem): boolean => item.state === 'review' || item.state === 'held';

/** The id of a piece's note box (ReviewTools), so Fix with no note can put the cursor in it. */
export const noteBoxId = (id: string): string => `review-note-${id}`;

function focusNote(id: string): void {
  if (typeof document === 'undefined') return;
  document.getElementById(noteBoxId(id))?.focus();
}

export class ReviewSession {
  /** The piece the owner picked in the list; null = the one that needs checking. */
  view = $state<string | null>(null);
  /** An older version being looked at; null = the newest. */
  version = $state<number | null>(null);
  /** What is being sent right now, in words; empty = nothing. */
  busy = $state('');
  /** Words for the picture's place while the studio makes what comes next. */
  message = $state('');
  /** Note text typed and not saved yet, by piece. */
  typed = $state<Record<string, string>>({});
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  select(id: string | null): void {
    this.view = id;
    this.version = null;
  }

  typedText(id: string): string {
    return (this.typed[id] ?? '').trim();
  }

  /** Notes waiting on a piece, counting a typed one. */
  waiting(item: ReviewItem): number {
    return item.pending + (this.typedText(item.id) ? 1 : 0);
  }

  /** OK on a piece in review; on a held piece it is "OK anyway" (the service keeps the unmet check on the version). */
  async ok(item: ReviewItem): Promise<void> {
    if (!decidable(item) || this.busy) return;
    const { service, calls, param, afterOk } = this.#config;
    await this.#guard('Saving your OK…', 'OK was not saved', async () => {
      const result = await service.call<DecisionResult | undefined>(`${calls}.ok`, { [param]: item.id });
      this.select(null);
      this.message = afterOk(item, result);
    });
  }

  /**
   * Fix: the notes (pending, plus one typed and not saved) go as one change. A held piece needs no note: the check that
   * was not satisfied goes with it. A piece in review with no note gets the note box focused instead of a dead click.
   */
  async fix(item: ReviewItem): Promise<void> {
    if (!decidable(item) || this.busy) return;
    const text = this.typedText(item.id);
    if (!item.pending && !text && item.state !== 'held') {
      focusNote(item.id);
      return;
    }
    const { service, calls, param } = this.#config;
    this.view = item.id; // stay on this piece while it is remade
    await this.#guard(
      item.pending + (text ? 1 : 0)
        ? `Sending ${plural(item.pending + (text ? 1 : 0), 'note')} as one change…`
        : 'Sending the check result as the change…',
      'The fix was not sent',
      async () => {
        await service.call(`${calls}.fix`, { [param]: item.id, ...(text ? { text } : {}) });
        // Only the words that were sent are cleared: anything typed while it was sending stays in the box.
        if (this.typedText(item.id) === text) this.typed[item.id] = '';
        this.version = null;
      },
    );
  }

  /** Drops the view if that piece is gone from the service. */
  keepIfPresent(ids: readonly string[]): void {
    if (this.view && !ids.includes(this.view)) this.view = null;
  }

  async #guard(label: string, problem: string, work: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    const { problems, problemId, reload } = this.#config;
    this.busy = label;
    problems.clear(problemId);
    try {
      await work();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.raise({ id: problemId, kind: 'warn', text: `${problem}: ${reason}. Nothing was changed.` });
    }
    this.busy = '';
    // Callers run this as `void session.ok/fix(...)`: a failed reload must reach the strip, not be an unhandled
    // rejection (MDN: unhandledrejection).
    try {
      await reload();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.raise({ id: problemId, kind: 'warn', text: `Could not read the pieces again: ${reason}.` });
    }
  }
}
