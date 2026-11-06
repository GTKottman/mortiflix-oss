import type { Problems } from '../../lib/stores/problems.svelte';
import type { SoftService } from './soft-service';
import type { ServiceSource, Value } from './types';

// The draft: the service keeps it (brief.draft.save, debounced); localStorage is only a crash backup.
// A draft belongs to the tab that started it (its id is kept in this tab's sessionStorage): a new tab starts a
// new draft and only offers the others under "Continue a draft", so two windows never write into one draft.

const BACKUP_KEY = 'mfx.np.backup.v3';
const TAB_KEY = 'mfx.np.draft';
const BACKUP_DAYS = 14;
const SAVE_AFTER_MS = 600;

interface Backup {
  brief: Record<string, Value>;
  draft: string | null;
  open: Record<string, boolean>;
  at: number;
}

interface SavedDraft {
  id: string;
  brief: Record<string, Value>;
  sources?: ServiceSource[];
}

/** A saved draft another tab (or an earlier visit) left, as `brief.draft.list` gives it. */
export interface OtherDraft {
  id: string;
  saved_at: string;
  idea_excerpt: string;
  sources: number;
}

interface SaveReply {
  draft?: string;
  saved_at?: string;
  errors?: { message: string }[];
}

/** What a restore found: the brief and its tray. */
export interface Restored {
  brief: Record<string, Value>;
  sources: ServiceSource[];
}

export interface DraftSource {
  contract: () => Record<string, Value>;
  open: () => Record<string, boolean>;
  hasContent: () => boolean;
}

const CLOCK = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

// Always 10 lowercase hex characters (the service and bridge want /^d-[a-z0-9]{6,12}$/; Math.random's base-36 could
// come out shorter). getRandomValues works on plain http too (LAN), unlike crypto.randomUUID.
const newId = (): string =>
  `d-${Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;

function tabDraft(): string | null {
  try {
    return sessionStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

function keepTabDraft(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(TAB_KEY, id);
    else sessionStorage.removeItem(TAB_KEY);
  } catch {
    // storage blocked: the draft lives as long as the page
  }
}

function readBackup(): Backup | null {
  try {
    const found = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? 'null') as Backup | null;
    return found && Date.now() - found.at < BACKUP_DAYS * 864e5 ? found : null;
  } catch {
    return null;
  }
}

export class Draft {
  #id = $state<string | null>(null);
  /** Drafts this tab does not own, newest first: offered, never loaded by themselves. */
  others = $state<OtherDraft[]>([]);
  /** "Draft saved 14:02", "Draft restored" or empty. */
  saved = $state('');
  readonly #soft: SoftService;
  readonly #problems: Problems;
  readonly #source: DraftSource;
  readonly #keepLocal: boolean;
  #made = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** `keepLocal` false (demo states): nothing is saved anywhere. */
  constructor(soft: SoftService, problems: Problems, source: DraftSource, keepLocal = true) {
    this.#soft = soft;
    this.#problems = problems;
    this.#source = source;
    this.#keepLocal = keepLocal;
  }

  get id(): string | null {
    return this.#id;
  }

  set id(id: string | null) {
    this.#id = id;
    if (this.#keepLocal) keepTabDraft(id);
  }

  /** The draft id, made on first use; the first call saves so the tray has a draft to put files in. */
  async ensure(): Promise<string> {
    this.id ??= newId();
    if (!this.#made) {
      this.#made = true;
      await this.save(true);
    }
    return this.id;
  }

  /** The service may answer with its own id. */
  adopt(id: string): void {
    this.id = id;
  }

  backup(): void {
    if (!this.#keepLocal) return;
    try {
      if (this.#source.hasContent()) {
        const entry: Backup = {
          brief: this.#source.contract(),
          draft: this.id,
          open: this.#source.open(),
          at: Date.now(),
        };
        localStorage.setItem(BACKUP_KEY, JSON.stringify(entry));
      } else localStorage.removeItem(BACKUP_KEY);
    } catch {
      // storage full or blocked: the service draft still holds the brief
    }
  }

  /** Saves soon (typing), or now. */
  save(now = false): Promise<void> {
    this.backup();
    if (!this.#keepLocal) return Promise.resolve();
    clearTimeout(this.#timer);
    if (!now) {
      this.#timer = setTimeout(() => void this.#send(), SAVE_AFTER_MS);
      return Promise.resolve();
    }
    return this.#send();
  }

  async #send(): Promise<void> {
    this.id ??= newId();
    this.#made = true;
    const reply = await this.#soft.call<SaveReply>('brief.draft.save', {
      draft: this.id,
      brief: this.#source.contract(),
    });
    if (!reply) {
      this.saved = 'Draft kept in this browser only';
      return;
    }
    this.id = reply.draft ?? this.id;
    const at = Date.parse(reply.saved_at ?? '') || Date.now();
    this.saved = `Draft saved ${CLOCK.format(at)}`;
    if (reply.errors?.length) {
      this.#problems.raise({
        id: 'np-draft',
        kind: 'warn',
        text: `Not saved in the draft: ${reply.errors.map((e) => e.message).join(' ')}`,
      });
    } else this.#problems.clear('np-draft');
  }

  /** This tab's own draft (after a reload); when the service is down, the browser's backup of it. A fresh tab
   *  restores nothing and lists the other drafts in `others`. */
  async restore(): Promise<Restored | null> {
    if (!this.#keepLocal) return null;
    const own = tabDraft();
    const found = await this.#listOthers(own);
    if (!own) return null;
    if (found) return this.#load(own);
    const backup = readBackup();
    if (backup?.draft !== own) return null;
    this.id = own;
    this.saved = 'Draft restored';
    return { brief: backup.brief, sources: [] };
  }

  /** Continue a draft from the list: this tab owns it from now on. */
  async continueWith(id: string): Promise<Restored | null> {
    clearTimeout(this.#timer);
    const restored = await this.#load(id);
    if (restored) this.others = this.others.filter((d) => d.id !== id);
    return restored;
  }

  /** Lists the drafts this tab does not own. False when the service did not answer. */
  async #listOthers(own: string | null): Promise<boolean> {
    const reply = await this.#soft.call<{ drafts?: OtherDraft[] }>('brief.draft.list', {});
    if (!reply) return false;
    this.others = (reply.drafts ?? []).filter((d) => d.id !== own && (d.idea_excerpt || d.sources));
    return true;
  }

  async #load(id: string): Promise<Restored | null> {
    const reply = await this.#soft.call<{ draft: SavedDraft | null }>('brief.draft.get', { draft: id });
    const draft = reply?.draft;
    if (!draft || !(Object.keys(draft.brief).some((k) => k !== 'version') || draft.sources?.length)) {
      if (reply) this.id = null;
      return null;
    }
    this.id = draft.id;
    this.#made = true;
    this.saved = 'Draft restored';
    return { brief: draft.brief, sources: draft.sources ?? [] };
  }

  /** The accordions that were open last time. */
  rememberedOpen(): Record<string, boolean> {
    return readBackup()?.open ?? {};
  }

  /** Start a blank brief: the old draft goes, so does the backup. */
  discard(): void {
    this.#forget();
  }

  /** The project exists: the draft and the backup are no longer needed. */
  finish(): void {
    this.#forget();
  }

  /** Drops the draft, its backup and any save still waiting, so nothing brings it back. */
  #forget(): void {
    const old = this.id;
    this.id = null;
    this.#made = false;
    this.saved = '';
    clearTimeout(this.#timer);
    try {
      localStorage.removeItem(BACKUP_KEY);
    } catch {
      // nothing to remove
    }
    if (old) void this.#soft.call('brief.draft.delete', { draft: old });
  }
}
