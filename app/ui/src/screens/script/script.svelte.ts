import { getContext, setContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { isNotBuiltYet } from '../../lib/service/client';
import type { Problems } from '../../lib/stores/problems.svelte';
import type { ScriptSource } from './source';
import type { Pending } from './status';
import {
  firstToReview,
  isCut,
  isDrafted,
  isWaiting,
  nextToReview,
  summarize,
  timingsFor,
  voiceByLine,
} from './timing';
import type { Beat, Decision, Drafts, LineEdit, NewLine, ScriptData, VoiceLine } from './types';

const without = <T>(record: Record<string, T>, ...keys: string[]): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

export type Scope = 'scene' | 'all';
export type ViewMode = 'compact' | 'full';
export type LoadState = 'loading' | 'ready' | 'failed' | 'too-old';

/** From this many scenes the list starts compact on its own. */
const COMPACT_FROM = 12;
const DRAFT_SAVE_MS = 400;
/** Reads again this many times, this far apart, before a first load counts as failed. */
const FIRST_TRIES = 3;
const FIRST_RETRY_MS = 1500;
const SAVE_PROBLEM = 'script-save';
const RELOAD_PROBLEM = 'script-reload';
const DRAFT_PROBLEM = 'script-draft';
const NEEDS_CONFIRM =
  'Saving would re-record voice. Re-record a line with Remake line on Voice & music, where the cost is shown first.';

export interface SceneError {
  /** What failed, in plain words: "Couldn't approve this scene". */
  title: string;
  message: string;
  /** Runs the failed step again when the owner presses Try again. */
  retry: () => Promise<void>;
}

const FAILED: Record<Pending, string> = {
  ok: "Couldn't approve this scene",
  clear: "Couldn't reopen this scene",
  undo: "Couldn't undo the last save",
};

/**
 * The Script screen's state: the script, the unsaved edits, which scenes are open for editing and the
 * selected scene. Components read it; they never call the service themselves.
 */
export class ScriptStore {
  data = $state<ScriptData | null>(null);
  voiceBy = $state<Record<string, VoiceLine>>({});
  /** Unsaved words by line id. */
  drafts = $state<Drafts>({});
  readonly editing = new SvelteSet<string>();
  selected = $state<string | null>(null);
  scope = $state<Scope>('scene');
  viewMode = $state<ViewMode | null>(null);
  loadState = $state<LoadState>('loading');
  loadError = $state('');
  saving = $state(false);
  errors = $state<Record<string, SceneError>>({});
  /** What is being sent for each scene right now: an OK, a Reopen or an Undo last save. */
  approving = $state<Record<string, Pending>>({});
  /** The words a scene had before its last save, so Undo last save can put them back. */
  undoable = $state<Record<string, LineEdit[]>>({});
  /** The scene that should take keyboard focus next, and the line to open in its editor. */
  focusRequest = $state<string | null>(null);
  editLine = $state<string | null>(null);
  /** Lines added in the editor and not saved yet, by scene. */
  added = $state<Record<string, NewLine[]>>({});
  #newKeys = 0;
  /** The Fix note open: a scene id, 'all' for the whole script, or null. */
  fixOpen = $state<string | null>(null);
  /** The typed Fix note, by scene id or 'all'; kept while the note is open. */
  fixWords = $state<Record<string, string>>({});
  /** A Fix being sent ('all' or a scene id). */
  fixSending = $state<string | null>(null);
  fixError = $state('');
  /** The last Fix that went out: shown as a one-line note until another starts. */
  fixSent = $state<string | null>(null);
  /** An OK records voice on ElevenLabs (paid): the OK says what it spends first. */
  voicePaid = $state(false);
  /** The script's stage key when the script is approved: a whole-script Fix then reopens it. Set by the toolbar. */
  reopenStage = $state<string | null>(null);

  readonly beats = $derived(this.data?.beats ?? []);
  readonly timings = $derived(
    timingsFor(this.beats, this.voiceBy, this.drafts, this.data?.words_per_minute ?? undefined),
  );
  readonly summary = $derived(summarize(this.beats, this.timings, this.drafts, this.data?.chosen_sec));
  readonly compact = $derived(this.viewMode ? this.viewMode === 'compact' : this.beats.length > COMPACT_FROM);
  readonly selectedBeat = $derived(this.beats.find((b) => b.id === this.selected) ?? null);
  /** A scene is open with unsaved words: Save is the screen's one gradient button. */
  readonly hasUnsavedEdit = $derived(
    this.beats.some((b) => this.editing.has(b.id) && (isDrafted(b, this.drafts) || this.addedCount(b) > 0)),
  );

  /** Added lines with words in this scene (an empty added box is not a change). */
  addedCount(beat: Beat): number {
    return (this.added[beat.id] ?? []).filter((l) => l.words.trim()).length;
  }

  readonly #source: ScriptSource;
  readonly #problems: Problems;
  readonly #wantedScene: string | null;
  #draftRestored = false;
  #draftTimer: ReturnType<typeof setTimeout> | undefined;
  #saveError: string | null = null;
  /** The script revision when the last Fix went out. */
  #fixRev: number | undefined;
  #firstTries = 0;
  /** Counts loads; only the newest one's answer is used (a 3 s poll, event reloads and post-save loads overlap). */
  #loads = 0;
  /** Why the last reload failed while scenes were on screen; empty = it read fine. */
  #reloadError = '';

  constructor(source: ScriptSource, problems: Problems, wantedScene: string | null) {
    this.#source = source;
    this.#problems = problems;
    this.#wantedScene = wantedScene;
  }

  get isFixture(): boolean {
    return this.#source.isFixture;
  }

  async load(): Promise<void> {
    const mine = ++this.#loads;
    try {
      const [data, voice, paid] = await Promise.all([
        this.#source.script(),
        this.#source.voice().catch(() => null),
        this.#source.voicePaid().catch(() => undefined),
      ]);
      if (mine !== this.#loads) return; // a newer load started: this answer is stale
      if (paid !== undefined) this.voicePaid = paid;
      // A rewrite came in (the revision moved since the Fix went out): the "Fix sent" note has done its job.
      if (this.fixSent && data.rev !== this.#fixRev) this.fixSent = null;
      // Read fine: a save problem left from before (another load, a service restart) is stale now.
      if (!this.#saveError) this.#problems.clear(SAVE_PROBLEM);
      this.#firstTries = 0;
      this.#reloadError = '';
      this.#problems.clear(RELOAD_PROBLEM);
      this.data = data;
      this.voiceBy = voiceByLine(voice);
      this.#restoreDraft(data);
      this.#dropStale(data);
      this.#pickScene(data);
      this.loadState = 'ready';
    } catch (error) {
      if (mine !== this.#loads) return;
      if (this.data) {
        this.#reloadError = messageOf(error);
        // The scenes stay on screen, but they may be old (after a Save they show the words from before it).
        this.#problems.raise({
          id: RELOAD_PROBLEM,
          kind: 'warn',
          text: `Couldn't read the script again: ${messageOf(error)}. What is on screen may be out of date.`,
          fix: {
            label: 'Try again',
            run: async () => {
              await this.load();
              if (this.#reloadError) throw new Error(this.#reloadError);
              return 'Read again.';
            },
          },
        });
        return;
      }
      // The first read right after a service (re)start can fail while it comes up: read again a few times first.
      if (!isNotBuiltYet(error) && this.#firstTries < FIRST_TRIES) {
        this.#firstTries += 1;
        setTimeout(() => void this.load(), FIRST_RETRY_MS);
        return;
      }
      this.loadError = error instanceof Error ? error.message : String(error);
      this.loadState = isNotBuiltYet(error) ? 'too-old' : 'failed';
    }
  }

  retry(): void {
    this.loadState = 'loading';
    void this.load();
  }

  select(id: string): void {
    this.selected = id;
  }

  /** Select a scene, bring it into view and give it keyboard focus. */
  reveal(id: string): void {
    this.selected = id;
    this.focusRequest = id;
  }

  goToNext(): void {
    const next = firstToReview(this.beats, this.drafts);
    if (next) this.reveal(next.id);
  }

  step(from: string, by: 1 | -1): void {
    const at = this.beats.findIndex((b) => b.id === from);
    const to = this.beats[at + by];
    if (to) this.reveal(to.id);
  }

  setView(mode: ViewMode): void {
    this.viewMode = mode;
    if (this.selected) this.focusRequest = this.selected;
  }

  startEdit(beat: Beat, lineId: string | null = null): void {
    if (isCut(beat)) return; // a cut scene is not in the video: nothing to edit or OK
    this.selected = beat.id;
    this.editLine = lineId;
    this.editing.add(beat.id);
  }

  /** Every keystroke in a line: the words are kept as an unsaved edit unless they match the saved ones. */
  setDraft(beat: Beat, lineId: string, typed: string): void {
    const saved = beat.lines.find((l) => l.id === lineId)?.words;
    const words = typed.replace(/\s+/g, ' ').trim();
    // An emptied line is removed on Save ('' in the drafts), like pressing its ✕.
    this.drafts = words !== saved ? { ...this.drafts, [lineId]: words } : without(this.drafts, lineId);
    this.#keepDraft();
  }

  /** ✕ on a line: removed on Save; keepLine takes that back. */
  removeLine(lineId: string): void {
    this.drafts = { ...this.drafts, [lineId]: '' };
    this.#keepDraft();
  }

  keepLine(lineId: string): void {
    this.drafts = without(this.drafts, lineId);
    this.#keepDraft();
  }

  /** + Add line: a new empty box at the end of the scene. */
  addLine(beat: Beat): string {
    const key = `new-${++this.#newKeys}`;
    this.added = { ...this.added, [beat.id]: [...(this.added[beat.id] ?? []), { key, words: '' }] };
    return key;
  }

  setNewLine(beat: Beat, key: string, typed: string): void {
    const words = typed.replace(/\s+/g, ' ').trim();
    this.added = {
      ...this.added,
      [beat.id]: (this.added[beat.id] ?? []).map((l) => (l.key === key ? { ...l, words } : l)),
    };
  }

  dropNewLine(beat: Beat, key: string): void {
    this.added = { ...this.added, [beat.id]: (this.added[beat.id] ?? []).filter((l) => l.key !== key) };
  }

  cancel(beat: Beat): void {
    this.drafts = without(this.drafts, ...beat.lines.map((l) => l.id));
    this.added = without(this.added, beat.id);
    this.editing.delete(beat.id);
    this.#keepDraft();
    this.#problems.clear(SAVE_PROBLEM);
    this.#saveError = null;
    this.reveal(beat.id);
  }

  async save(beat: Beat): Promise<void> {
    if (this.saving) return;
    const changed = beat.lines.filter((l) => l.id in this.drafts);
    const fresh = (this.added[beat.id] ?? []).filter((l) => l.words.trim());
    if (!changed.length && !fresh.length) {
      this.added = without(this.added, beat.id);
      this.editing.delete(beat.id);
      return;
    }
    const removing = (id: string) => this.drafts[id] === '';
    const edits: LineEdit[] = changed.map((l) =>
      removing(l.id)
        ? { beat: beat.id, line: l.id, delete: true }
        : { beat: beat.id, line: l.id, words: this.drafts[l.id] ?? l.words },
    );
    // Added lines go after the scene's last line that stays, each after the one before it.
    let after: string | null = beat.lines.filter((l) => !removing(l.id)).at(-1)?.id ?? null;
    fresh.forEach((l, k) => {
      const key = `n${k + 1}`;
      edits.push({ beat: beat.id, add_after: after, words: l.words, key });
      after = key;
    });
    const before: LineEdit[] = changed.map((l) =>
      removing(l.id)
        ? { beat: beat.id, line: l.id, delete: false }
        : { beat: beat.id, line: l.id, words: l.words },
    );
    this.saving = true;
    this.#saveError = null;
    try {
      const result = await this.#source.edit(edits);
      if (result.needs_confirm) throw new Error(result.message ?? NEEDS_CONFIRM);
      this.drafts = without(this.drafts, ...beat.lines.map((l) => l.id));
      this.added = without(this.added, beat.id);
      this.editing.delete(beat.id);
      // Undo takes added lines out again (kept, hidden, like any removed line).
      for (const id of result.added ?? []) before.push({ beat: beat.id, line: id, delete: true });
      this.undoable = { ...this.undoable, [beat.id]: before };
      this.#keepDraft();
      this.#problems.clear(SAVE_PROBLEM);
      this.saving = false;
      await this.load();
      this.reveal(beat.id);
    } catch (error) {
      this.saving = false;
      this.#saveError = error instanceof Error ? error.message : String(error);
      this.#problems.raise({
        id: SAVE_PROBLEM,
        kind: 'bad',
        text: `Your script changes are not saved: ${this.#saveError}. Your edits are kept.`,
        fix: {
          label: 'Try again',
          run: async () => {
            await this.save(beat);
            if (this.#saveError) throw new Error(this.#saveError);
            return 'Saved.';
          },
        },
      });
    }
  }

  async undo(beat: Beat): Promise<void> {
    const before = this.undoable[beat.id];
    if (!before || this.saving || this.approving[beat.id]) return;
    this.undoable = without(this.undoable, beat.id);
    this.approving = { ...this.approving, [beat.id]: 'undo' };
    this.errors = without(this.errors, beat.id);
    try {
      const result = await this.#source.edit(before);
      if (result.needs_confirm) throw new Error(result.message ?? NEEDS_CONFIRM);
    } catch (error) {
      this.undoable = { ...this.undoable, [beat.id]: before };
      this.#fail(beat, 'undo', error, () => this.undo(beat));
    }
    this.approving = without(this.approving, beat.id);
    await this.load();
    this.reveal(beat.id);
  }

  async decide(beat: Beat, action: Decision): Promise<void> {
    if (this.approving[beat.id] || (action === 'ok' && isCut(beat))) return;
    // Try again can come after a reload: look the scene up again so "next" is found from where it is now.
    const now = this.beats.find((b) => b.id === beat.id) ?? beat;
    const next = action === 'ok' ? nextToReview(this.beats, now, this.drafts) : undefined;
    this.approving = { ...this.approving, [beat.id]: action };
    this.errors = without(this.errors, beat.id);
    let reveal: string | null = null;
    try {
      await this.#source.decide(beat.id, action);
      reveal = next?.id ?? beat.id;
    } catch (error) {
      this.#fail(beat, action, error, () => this.decide(beat, action));
    }
    this.approving = without(this.approving, beat.id);
    await this.load();
    if (reveal) this.reveal(reveal);
  }

  /** Opens the Fix note for a scene or for the whole script ('all'). */
  openFix(target: string): void {
    // A scene open for editing shows its editor, not the Fix note (SceneRow), and a cut scene has neither: opening
    // one there would look like a dead button. Save or Cancel the edit first.
    const beat = target === 'all' ? null : this.beats.find((b) => b.id === target);
    if (beat && (this.editing.has(beat.id) || isCut(beat))) return;
    this.fixOpen = target;
    this.fixError = '';
    // The rewrite switch follows what the Fix is for, so the two never disagree.
    this.scope = target === 'all' ? 'all' : 'scene';
    this.fixSent = null;
    if (target !== 'all') this.select(target);
  }

  closeFix(): void {
    if (this.fixOpen) this.fixWords = without(this.fixWords, this.fixOpen);
    this.fixOpen = null;
    this.fixError = '';
  }

  /** Sends the open Fix note: Mortiflix rewrites that scene, or the whole script, from the owner's words. */
  async sendFix(): Promise<void> {
    const target = this.fixOpen;
    const text = target ? (this.fixWords[target] ?? '').trim() : '';
    if (!target || !text || this.fixSending) return;
    this.fixSending = target;
    this.fixError = '';
    this.#fixRev = this.data?.rev;
    try {
      if (target === 'all') await this.#source.fixScript(text, this.reopenStage);
      else await this.#source.fixScene(target, text);
      this.fixWords = without(this.fixWords, target);
      this.fixOpen = null;
      this.fixSent = target;
    } catch (error) {
      this.fixError = messageOf(error);
    } finally {
      this.fixSending = null;
    }
    if (this.fixSent === target) {
      await this.load();
      if (target !== 'all') this.reveal(target);
    }
  }

  /** Enter on a focused scene: approve it when it waits and is not open for editing. */
  approve(beat: Beat): void {
    if (isWaiting(beat) && !this.approving[beat.id] && !this.editing.has(beat.id))
      void this.decide(beat, 'ok');
  }

  #fail(beat: Beat, step: Pending, error: unknown, retry: () => Promise<void>): void {
    this.errors = { ...this.errors, [beat.id]: { title: FAILED[step], message: messageOf(error), retry } };
  }

  #keepDraft(): void {
    clearTimeout(this.#draftTimer);
    this.#draftTimer = setTimeout(() => this.flushDraft(), DRAFT_SAVE_MS);
  }

  /**
   * Sends the unsaved words now if a keep is still waiting (the screen is left or hidden before the 400 ms pass).
   * A failed keep says so: the words are then only on this screen.
   */
  flushDraft(): void {
    if (this.#draftTimer === undefined) return;
    clearTimeout(this.#draftTimer);
    this.#draftTimer = undefined;
    const lines = Object.keys(this.drafts).length > 0 ? $state.snapshot(this.drafts) : null;
    this.#source.keepDraft(lines).then(
      () => this.#problems.clear(DRAFT_PROBLEM),
      (error: unknown) =>
        this.#problems.raise({
          id: DRAFT_PROBLEM,
          kind: 'warn',
          text: `Your unsaved script words could not be kept for later: ${messageOf(error)}. Save them on Script before you close the app.`,
        }),
    );
  }

  /** On the first load only: unsaved edits from before a reload come back open. */
  #restoreDraft(data: ScriptData): void {
    if (this.#draftRestored) return;
    this.#draftRestored = true;
    if (!data.draft?.lines || Object.keys(this.drafts).length) return;
    this.drafts = { ...data.draft.lines };
    for (const beat of data.beats) if (isDrafted(beat, this.drafts)) this.editing.add(beat.id);
  }

  /** Drop edits that now equal the saved words, or whose line is gone. */
  #dropStale(data: ScriptData): void {
    const lines = data.beats.flatMap((b) => b.lines);
    const stale = Object.entries(this.drafts)
      .filter(
        ([id, words]) => lines.find((l) => l.id === id)?.words === words || !lines.some((l) => l.id === id),
      )
      .map(([id]) => id);
    if (stale.length) this.drafts = without(this.drafts, ...stale);
    for (const id of [...this.editing]) if (!data.beats.some((b) => b.id === id)) this.editing.delete(id);
  }

  #pickScene(data: ScriptData): void {
    if (data.beats.some((b) => b.id === this.selected)) return;
    const wanted = data.beats.find((b) => b.id === this.#wantedScene);
    this.selected = (wanted ?? data.beats.find(isWaiting) ?? data.beats[0])?.id ?? null;
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const KEY = Symbol('script-store');
export const provideScript = (store: ScriptStore): ScriptStore => setContext(KEY, store);
export function useScript(): ScriptStore {
  const store = getContext<ScriptStore | undefined>(KEY);
  if (!store) throw new Error('The script store is missing: render inside ScriptScreen.');
  return store;
}
