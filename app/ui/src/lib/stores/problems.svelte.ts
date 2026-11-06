// The Fix it strip's list (owner 2026-11-01: errors only, one strip under the top bar, never below the fold).
// Same id = update in place. One problem shows at a time, 'bad' first, then oldest. Fix it runs once per press; its
// answer shows for a few seconds, a failure says so plainly. The button stays, so the owner can press it again after
// fixing the cause (e.g. signing in); nothing retries by itself. A fix that never answers is given up after FIX_MS.

import { untrack } from 'svelte';

export type ProblemKind = 'warn' | 'bad';

export interface ProblemFix {
  /** Button words. Default "Fix it". */
  label?: string;
  /** Does the fix; returns what was done, in plain words. */
  run: () => Promise<string | undefined>;
}

export interface Problem {
  id: string;
  text: string;
  kind?: ProblemKind;
  fix?: ProblemFix | null;
  /** A second, quieter button (e.g. "Let the AI take over" next to Resume). */
  also?: ProblemFix | null;
}

interface Entry {
  id: string;
  text: string;
  kind: ProblemKind;
  fix: ProblemFix | null;
  also: ProblemFix | null;
  since: number;
  /** The text it was raised with: a failed fix keeps its own message until the cause changes. */
  raisedText: string;
  failed: boolean;
}

export type StripLook = ProblemKind | 'busy' | 'ok';

/** How long one Fix it may take before the strip stops waiting (a lost reply must not lock every Fix it). */
const FIX_MS = 60_000;

class FixTimeout extends Error {}

export class Problems {
  #entries = $state<Entry[]>([]);
  /** What the last fix did, shown in place of the problem for a moment. */
  done = $state<string | null>(null);
  fixing = $state(false);
  readonly #doneMs: number;
  readonly #fixMs: number;
  #doneTimer: ReturnType<typeof setTimeout> | undefined;
  #clock = 0;

  constructor({ doneMs = 4000, fixMs = FIX_MS }: { doneMs?: number; fixMs?: number } = {}) {
    this.#doneMs = doneMs;
    this.#fixMs = fixMs;
  }

  get list(): Entry[] {
    return [...this.#entries].sort(
      (a, b) => (a.kind === 'bad' ? 0 : 1) - (b.kind === 'bad' ? 0 : 1) || a.since - b.since,
    );
  }

  get current(): Entry | null {
    return this.list[0] ?? null;
  }

  get look(): StripLook {
    if (this.done) return 'ok';
    if (this.fixing) return 'busy';
    return this.current?.kind ?? 'warn';
  }

  // raise and clear read the list untracked (svelte.dev/docs/svelte/svelte#untrack): an effect that publishes its notices
  // must not depend on the list it writes, or each write wakes it again (effect_update_depth_exceeded: Finish of Ice,
  // 2026-11-03, raise writes a new list even for the same notice because its Fix button is a new function each time)
  raise(problem: Problem): void {
    untrack(() => this.#raise(problem));
  }

  #raise(problem: Problem): void {
    const old = this.#entries.find((e) => e.id === problem.id);
    if (old?.failed && old.raisedText === problem.text) return;
    const entry: Entry = {
      id: problem.id,
      text: problem.text,
      kind: problem.kind ?? 'warn',
      fix: problem.fix ?? null,
      also: problem.also ?? null,
      since: old?.since ?? ++this.#clock,
      raisedText: problem.text,
      failed: false,
    };
    this.#entries = old
      ? this.#entries.map((e) => (e.id === problem.id ? entry : e))
      : [...this.#entries, entry];
  }

  clear(id: string): void {
    // nothing to clear writes nothing: effects that clear their own notice read the list, and a write every time made
    // them wake each other forever (effect_update_depth_exceeded, Voice & music stuck on "Loading the lines…", Dir3)
    untrack(() => {
      if (!this.#entries.some((e) => e.id === id)) return;
      this.#entries = this.#entries.filter((e) => e.id !== id);
    });
  }

  /** Runs the strip's button; `also` = the second one. */
  async fix(also = false): Promise<void> {
    const problem = this.current;
    const fix = also ? problem?.also : problem?.fix;
    if (!problem || !fix || this.fixing) return;
    this.fixing = true;
    // MDN Promise.race: settles with the first of the promises to settle; used here as the time limit.
    let limit: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      limit = setTimeout(() => reject(new FixTimeout()), this.#fixMs);
    });
    try {
      const said = await Promise.race([fix.run(), timeout]);
      this.clear(problem.id);
      this.#showDone(said || 'Fixed.');
    } catch (error) {
      const text =
        error instanceof FixTimeout
          ? `Fix it got no answer in ${Math.round(this.#fixMs / 1000)} s. It may still finish: check before pressing it again.`
          : `Fix it did not work: ${error instanceof Error ? error.message : 'unknown error'}. Nothing was changed.`;
      this.#entries = this.#entries.map((e) => (e.id === problem.id ? { ...e, kind: 'bad', failed: true, text } : e));
    } finally {
      clearTimeout(limit);
      this.fixing = false;
    }
  }

  #showDone(text: string): void {
    this.done = text;
    clearTimeout(this.#doneTimer);
    this.#doneTimer = setTimeout(() => (this.done = null), this.#doneMs);
  }
}
