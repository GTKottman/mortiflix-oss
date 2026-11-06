import { isNotBuiltYet, type ServiceClient } from '../../lib/service/client';
import type { Problems } from '../../lib/stores/problems.svelte';
import { fromContract, hasContent } from './brief';
import { Draft } from './draft.svelte';
import { BriefForm } from './form.svelte';
import { LiveBrief, type LiveDemo } from './live.svelte';
import fallbackSchema from './schema.fallback.json';
import { SoftService } from './soft-service';
import { TraySources } from './sources.svelte';
import type { BriefSchema } from './types';

// The New project screen's whole state: the brief being written, its draft, its source tray, the live brief and
// Create script. Components read it; nothing else talks to the service for this screen.

const MIN_IDEA_LETTERS = 8;
const DEMO_CALLS = ['brief.schema', 'brief.summary'];

/** These codes mean the request went out and the answer never came: the project may exist already. */
const OUTCOME_UNKNOWN = ['link_lost', 'service_stopped'];
/** How far apart this browser's clock and the service's may be when looking for the project a lost answer made. */
const CLOCK_SLACK_MS = 2 * 60_000;

interface ListedProject {
  id: string;
  title?: string;
  created_at?: string;
}

interface CreatedReply {
  id?: string;
  project?: string | { id?: string };
}

export interface NewProjectOptions {
  /** The project exists: open it and go to its Script. Rejects when it could not be opened. */
  onCreated: (id: string) => Promise<void>;
  /** Screenshot states: the form is real, but nothing is saved, created or asked of Claude. */
  demo?: LiveDemo | null;
}

/** Places elsewhere on the screen that a link can send the owner's focus to. */
export type FocusTarget = 'link' | 'destination' | 'idea';

const isSchema = (value: unknown): value is BriefSchema =>
  typeof value === 'object' && value !== null && Array.isArray((value as { sections?: unknown }).sections);

export class NewProject {
  readonly form: BriefForm;
  readonly draft: Draft;
  readonly sources: TraySources;
  readonly live: LiveBrief;
  /** Create script is running. */
  busy = $state(false);
  /** A saved draft was put back on screen. */
  restored = $state(false);
  readonly #client: ServiceClient;
  readonly #soft: SoftService;
  readonly #problems: Problems;
  readonly #onCreated: (id: string) => Promise<void>;
  readonly #demo: boolean;
  #created: string | null = null;
  /** When a Create whose answer was lost was sent (ms), so Try again checks for its project first. */
  #unsure: number | null = null;
  // The id of one Create attempt (service project.new request_id): kept while that attempt's answer is unknown, so a
  // retry gets the project the first try made instead of a second one (IETF Idempotency-Key draft).
  #requestId: string | null = null;
  readonly #focusers: Partial<Record<FocusTarget, () => void>> = {};

  constructor(client: ServiceClient, problems: Problems, options: NewProjectOptions) {
    this.#client = client;
    this.#problems = problems;
    this.#onCreated = options.onCreated;
    this.#demo = Boolean(options.demo);
    this.#soft = new SoftService(client, this.#demo ? DEMO_CALLS : null);
    this.form = new BriefForm(() => this.#changed());
    this.draft = new Draft(
      this.#soft,
      problems,
      {
        contract: () => this.form.contract(this.sources.ids),
        open: () => this.form.open,
        hasContent: () => hasContent(this.form.parts(this.sources.ids)),
      },
      !this.#demo,
    );
    this.sources = new TraySources(client, this.draft, problems, () => this.#changed());
    this.live = new LiveBrief(
      client,
      this.#soft,
      problems,
      this.form,
      { sourceIds: () => this.sources.ids, draftId: () => this.draft.id },
      options.demo ?? null,
    );
  }

  /** The service for presets: the same quiet calls as the draft. */
  get soft(): SoftService {
    return this.#soft;
  }

  get client(): ServiceClient {
    return this.#client;
  }

  /** Loads the form, then puts back the last draft. */
  async start(): Promise<void> {
    const answer = await this.#soft.call<BriefSchema>('brief.schema');
    if (isSchema(answer)) this.form.schema = answer;
    else {
      this.form.schema = fallbackSchema as BriefSchema;
      this.live.down = true;
      if (!this.#demo) {
        this.#problems.raise({
          id: 'np-svc',
          kind: 'warn',
          text: 'The studio service is not answering. The form is drawn from a saved copy; the live brief, drafts and sources wait for the service. Your text is kept in this browser.',
        });
      }
    }
    const found = await this.draft.restore();
    if (found) {
      this.form.load(fromContract(found.brief));
      this.sources.replace(found.sources);
      this.restored = true;
    }
    this.form.open = this.draft.rememberedOpen();
    this.live.refresh();
  }

  /** A piece of the screen says where its focus target is, so other pieces can ask for it. Returns how to stop. */
  registerFocus(target: FocusTarget, focus: () => void): () => void {
    this.#focusers[target] = focus;
    return () => {
      this.#focusers[target] = undefined;
    };
  }

  focus(target: FocusTarget): void {
    this.#focusers[target]?.();
  }

  toggleSection(id: string): void {
    this.form.toggleOpen(id);
    this.draft.backup();
  }

  /** Continue a draft from "Continue a draft": what is on screen now is saved in its own draft first. */
  async continueDraft(id: string): Promise<void> {
    if (this.busy) return;
    if (this.draft.id) await this.draft.save(true);
    const found = await this.draft.continueWith(id);
    if (!found) {
      this.#problems.raise({
        id: 'np-continue',
        kind: 'warn',
        text: 'That draft could not be opened. It may have been used for a project already.',
      });
      return;
    }
    this.#problems.clear('np-continue');
    this.form.load(fromContract(found.brief));
    this.sources.replace(found.sources);
    this.restored = true;
    this.live.refresh();
  }

  /** Start a blank brief. */
  blank(): void {
    this.draft.discard();
    this.form.clear();
    this.sources.replace([]);
    this.live.clear();
    this.restored = false;
    this.#changed();
  }

  get valid(): boolean {
    return this.form.idea.trim().length >= MIN_IDEA_LETTERS && !this.sources.uploading;
  }

  /** The project was made but did not open yet: Create script only opens it. */
  get created(): boolean {
    return this.#created !== null;
  }

  /** The line left of the buttons: why Create script is not ready, or what happens next. */
  get why(): string {
    if (this.busy && this.#created) return 'Opening your project. Mortiflix is writing the brief…';
    if (this.busy) return 'Creating your project…';
    if (this.#created) return 'Your project is made. Open it to see the brief being written.';
    if (this.sources.uploading) return 'Waiting for the files to upload…';
    if (this.valid) return '';
    if (this.form.idea.trim()) return 'A few more words please: what is it about, and for whom?';
    return '';
  }

  lock(on: boolean): void {
    this.busy = on;
  }

  async create(): Promise<void> {
    if (this.busy) return;
    if (this.#created) return this.#open(this.#created);
    if (!this.valid) return;
    this.#problems.clear('np-create');
    const title = this.form.title.trim();
    const draft = this.draft.id;
    this.busy = true;
    // The last try's answer was lost: look for the project it may have made before asking for another one.
    if (this.#unsure !== null) {
      let made: string | null;
      try {
        made = await this.#madeSince(this.#unsure, title);
      } catch (error) {
        // Not known whether it was made: never send a second Create blind.
        this.busy = false;
        this.#problems.raise({
          id: 'np-create',
          kind: 'bad',
          text: `Couldn't check whether your project was made: ${error instanceof Error ? error.message : 'failed'} Nothing new was sent. Your brief is kept.`,
          fix: {
            label: 'Try again',
            run: async () => {
              await this.create();
              return 'Trying again.';
            },
          },
        });
        return;
      }
      this.#unsure = null;
      if (made) {
        this.#created = made;
        this.draft.finish();
        await this.#open(made);
        return;
      }
    }
    const askedAt = Date.now();
    try {
      this.#requestId ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(''); // works on plain-http LAN, unlike randomUUID
      const reply = await this.#client.call<CreatedReply>('project.new', {
        request_id: this.#requestId,
        preset: 'v3',
        idea: this.form.idea.trim(),
        ...(title ? { title } : {}),
        brief: this.form.contract(this.sources.ids),
        ...(draft ? { draft } : {}),
        start: true,
      });
      const id = reply.id ?? (typeof reply.project === 'string' ? reply.project : reply.project?.id);
      if (!id) throw new Error('The service did not say which project it made.');
      this.#created = id;
      this.#requestId = null;
      this.draft.finish();
    } catch (error) {
      this.busy = false;
      const message = error instanceof Error ? error.message : 'failed';
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (OUTCOME_UNKNOWN.includes(code)) this.#unsure = askedAt;
      else this.#requestId = null; // a clear refusal: the next Create is a new attempt
      // findPipeline's own words when this build has no v3 pipeline (pipelines.mjs: `no pipeline "<slug>"`); any other
      // error, e.g. one that names `visual.style.preset`, is shown as it is.
      const soon = isNotBuiltYet(error) || /^no pipeline "/.test(message);
      this.#problems.raise({
        id: 'np-create',
        kind: 'bad',
        text: soon
          ? 'Creating a project is not available in this build yet. Nothing was made, and your brief is kept.'
          : `Could not create the project: ${message} Your brief is kept.`,
        fix: {
          label: 'Try again',
          run: async () => {
            await this.create();
            return 'Trying again.';
          },
        },
      });
      return;
    }
    await this.#open(this.#created);
  }

  /**
   * The project a lost answer may have made: one listed as created since `since` (with clock slack) and, when the owner
   * gave a title, with that title. Null when none; rejects when the list can't be read.
   */
  async #madeSince(since: number, title: string): Promise<string | null> {
    const list = await this.#client.call<ListedProject[]>('project.list');
    const found = list.find(
      (p) => Date.parse(p.created_at ?? '') >= since - CLOCK_SLACK_MS && (!title || (p.title ?? '').trim() === title),
    );
    return found?.id ?? null;
  }

  /** Opens the made project; on failure the screen unlocks and says so, and Open project tries again. */
  async #open(id: string): Promise<void> {
    this.busy = true;
    this.#problems.clear('np-open');
    try {
      await this.#onCreated(id);
    } catch (error) {
      this.busy = false;
      this.#problems.raise({
        id: 'np-open',
        kind: 'bad',
        text: `Your project is made, but it did not open: ${error instanceof Error ? error.message : 'failed'}`,
        fix: {
          label: 'Open project',
          run: async () => {
            await this.#open(id);
            return 'Opening.';
          },
        },
      });
    }
  }

  #changed(): void {
    void this.draft.save();
    this.live.refresh();
  }
}
