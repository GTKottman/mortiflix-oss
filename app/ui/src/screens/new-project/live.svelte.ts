import type { ServiceClient } from '../../lib/service/client';
import type { Problems } from '../../lib/stores/problems.svelte';
import type { BriefForm } from './form.svelte';
import type { SoftService } from './soft-service';
import type { Conflict, Suggestion, Summary, Value } from './types';

// The live brief: the rule-based summary (brief.summary, on every change, debounced) and Claude's suggestions
// (brief.improve, only when the owner asks).

const SUMMARY_AFTER_MS = 300;
const PRETEND_THINKING_MS = 200;

export interface LiveSource {
  /** Ids of the tray's finished sources. */
  sourceIds: () => string[];
  draftId: () => string | null;
}

/** Demo states for screenshots: no service call, these suggestions instead. */
export interface LiveDemo {
  suggestions: Suggestion[];
}

export class LiveBrief {
  summary = $state<Summary | null>(null);
  suggestions = $state<Suggestion[]>([]);
  improving = $state(false);
  improved = $state(false);
  /** Why Improve gave nothing: the service's note (the AI call failed, demo backend) or the error. Null = it read fine. */
  note = $state<string | null>(null);
  /** The summary could not be had because the service did not answer. */
  down = $state(false);
  /** Conflicts the owner chose to keep. */
  #ignored = $state<string[]>([]);
  readonly #client: ServiceClient;
  readonly #soft: SoftService;
  readonly #problems: Problems;
  readonly #form: BriefForm;
  readonly #source: LiveSource;
  readonly #demo: LiveDemo | null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #latest = 0;

  constructor(
    client: ServiceClient,
    soft: SoftService,
    problems: Problems,
    form: BriefForm,
    source: LiveSource,
    demo: LiveDemo | null,
  ) {
    this.#client = client;
    this.#soft = soft;
    this.#problems = problems;
    this.#form = form;
    this.#source = source;
    this.#demo = demo;
  }

  get conflicts(): Conflict[] {
    return (this.summary?.conflicts ?? []).filter((c) => !this.#ignored.includes(c.id));
  }

  keep(conflict: Conflict): void {
    this.#ignored = [...this.#ignored, conflict.id];
  }

  /** Asks for a fresh summary soon; only the newest answer is used. */
  refresh(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#fetch(), SUMMARY_AFTER_MS);
  }

  async #fetch(): Promise<void> {
    const mine = ++this.#latest;
    if (!this.#form.idea.trim()) {
      this.summary = null;
      this.down = false;
      return;
    }
    const draft = this.#source.draftId();
    const reply = await this.#soft.call<Summary>('brief.summary', {
      brief: this.#brief(),
      ...(draft && !this.#demo ? { draft } : {}),
    });
    if (mine !== this.#latest) return;
    if (reply) {
      this.summary = reply;
      this.down = false;
    } else if (!this.#demo) this.down = true;
  }

  async improve(): Promise<void> {
    this.improving = true;
    this.improved = false;
    this.note = null;
    try {
      if (this.#demo) {
        await new Promise((done) => setTimeout(done, PRETEND_THINKING_MS));
        this.suggestions = this.#demo.suggestions;
      } else {
        const draft = this.#source.draftId();
        const reply = await this.#client.call<{ suggestions?: Suggestion[]; source?: string; note?: string }>(
          'brief.improve',
          {
            brief: this.#brief(),
            ...(draft ? { draft } : {}),
          },
        );
        this.suggestions = reply.suggestions ?? [];
        // source 'ai' = Claude read it; anything else (error, demo, none) carries a note saying why nothing came back.
        if (reply.source !== 'ai' && reply.note) this.note = reply.note;
      }
    } catch (error) {
      this.suggestions = [];
      this.note = `Couldn't improve the brief: ${error instanceof Error ? error.message : 'failed'}`;
      this.#problems.raise({
        id: 'np-improve',
        kind: 'warn',
        text: `Couldn't improve the brief: ${error instanceof Error ? error.message : 'failed'}. Nothing was changed.`,
      });
    }
    this.improving = false;
    this.improved = true;
  }

  accept(suggestion: Suggestion): void {
    if (suggestion.kind === 'set' && suggestion.path && suggestion.value !== undefined) {
      this.#form.accept(suggestion.path, suggestion.value as Value);
    }
    this.dismiss(suggestion);
  }

  dismiss(suggestion: Suggestion): void {
    this.suggestions = this.suggestions.filter((s) => s !== suggestion);
  }

  /** A blank brief: nothing from the old one stays. */
  clear(): void {
    clearTimeout(this.#timer);
    this.#latest++;
    this.#ignored = [];
    this.down = false;
    this.summary = null;
    this.suggestions = [];
    this.improved = false;
    this.note = null;
  }

  #brief(): Record<string, Value> {
    return this.#form.contract(this.#demo ? [] : this.#source.sourceIds());
  }
}
