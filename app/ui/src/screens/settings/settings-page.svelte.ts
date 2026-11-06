import { isNotBuiltYet, type ServiceClient } from '../../lib/service/client';
import { claudeConnected, type KeyStatus, type SetupStatus } from '../../lib/setup/status';
import type {
  AccessSettings,
  CapSettings,
  ComponentStatus,
  ComponentsAnswer,
  LanSettings,
  VideoNotesStatus,
} from './types';

// What the Settings sections share: Claude Code's status, the ElevenLabs key and daily credit cap, Video Notes,
// home-network access and the other connections, each loaded on its own so one slow answer never holds up the rest.

type Client = Pick<ServiceClient, 'call'>;

const VOICE_KEY = 'elevenlabs';

const reason = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

export class SettingsPage {
  status = $state<SetupStatus | null>(null);
  /** Why `setup.status` could not be read, or null (still asking, or read). */
  statusError = $state<string | null>(null);
  checking = $state(false);
  keys = $state<KeyStatus[]>([]);
  /** `keys.list` has answered at least once. */
  keysLoaded = $state(false);
  keysFailed = $state<string | null>(null);
  /** Saving or removing the key right now. */
  keyBusy = $state<'save' | 'remove' | null>(null);
  keyError = $state<string | null>(null);
  /** The free check of the saved key (keys.check) after Save: ok true/false, or null = could not tell. */
  keyCheck = $state<{ ok: boolean | null; detail: string } | null>(null);
  videoNotes = $state<VideoNotesStatus | null>(null);
  /** The service does not have Video Notes yet. */
  videoNotesSoon = $state(false);
  videoNotesError = $state<string | null>(null);
  videoNotesBusy = $state(false);
  components = $state<ComponentStatus[] | null>(null);
  /** Why `components.status` could not be read, or null (still asking, or read). */
  componentsError = $state<string | null>(null);
  /** Home-network access (`settings.get` lan), or null until read. */
  lan = $state<LanSettings | null>(null);
  /** The daily ElevenLabs credit cap (`settings.get` paid), or null until read. */
  cap = $state<CapSettings | null>(null);
  accessError = $state<string | null>(null);
  lanBusy = $state(false);
  lanError = $state<string | null>(null);
  capBusy = $state(false);
  capError = $state<string | null>(null);
  /** First run: the welcome line and "Done, start making". */
  firstRun = $state(false);
  readonly #client: Client;

  constructor(client: Client, firstRun = false) {
    this.#client = client;
    this.firstRun = firstRun;
  }

  readonly voiceKeySet = $derived(!!this.keys.find((key) => key.id === VOICE_KEY)?.set);
  readonly writingReady = $derived(claudeConnected(this.status?.claude));

  /** Everything the page shows, started together. */
  start(): void {
    void this.loadStatus();
    void this.loadKeys();
    void this.loadVideoNotes();
    void this.loadComponents();
    void this.loadAccess();
  }

  /** The lan and paid parts of a `settings.get` answer or a `settings.changed` event. */
  applyAccess(answer: AccessSettings | null | undefined): void {
    if (answer?.lan) this.lan = answer.lan;
    if (answer?.paid) this.cap = answer.paid;
  }

  async loadAccess(): Promise<void> {
    try {
      this.applyAccess(await this.#client.call<AccessSettings>('settings.get'));
      this.accessError = null;
    } catch (error) {
      this.accessError = reason(error);
    }
  }

  async setLan(enabled: boolean): Promise<void> {
    this.lanBusy = true;
    this.lanError = null;
    try {
      this.applyAccess(await this.#client.call<AccessSettings>('settings.set', { lan: { enabled } }));
    } catch (error) {
      this.lanError = `Couldn't change that: ${reason(error)}`;
    }
    this.lanBusy = false;
  }

  /** Saves the cap (null = no cap). Returns whether it was saved. */
  async setCap(dailyCap: number | null): Promise<boolean> {
    this.capBusy = true;
    this.capError = null;
    let saved = false;
    try {
      this.applyAccess(
        await this.#client.call<AccessSettings>('settings.set', { paid: { daily_cap: dailyCap } }),
      );
      saved = true;
    } catch (error) {
      this.capError = `Not saved: ${reason(error)}`;
    }
    this.capBusy = false;
    return saved;
  }

  async loadStatus(refresh = false): Promise<void> {
    this.statusError = null;
    try {
      this.status = await this.#client.call<SetupStatus>('setup.status', refresh ? { refresh: true } : {});
    } catch (error) {
      this.status = null;
      this.statusError = reason(error);
    }
    this.firstRun ||= !!this.status?.first_run;
  }

  async recheck(): Promise<void> {
    this.checking = true;
    await this.loadStatus(true);
    this.checking = false;
  }

  async loadKeys(): Promise<void> {
    try {
      this.keys = await this.#client.call<KeyStatus[]>('keys.list');
      this.keysLoaded = true;
      this.keysFailed = null;
    } catch (error) {
      this.keysFailed = reason(error);
    }
  }

  async saveKey(value: string): Promise<boolean> {
    this.keyBusy = 'save';
    this.keyError = null;
    let saved = false;
    try {
      await this.#client.call('keys.set', { id: VOICE_KEY, value });
      saved = true;
      this.keyCheck = null;
      await this.loadStatus();
      // Saved is not the same as working: ask ElevenLabs once (keys.check reads the account; no credits are spent).
      try {
        this.keyCheck = await this.#client.call<{ ok: boolean | null; detail: string }>('keys.check', {
          id: VOICE_KEY,
        });
      } catch (error) {
        this.keyCheck = { ok: null, detail: `couldn't check it (${reason(error)})` };
      }
    } catch (error) {
      this.keyError = `Not saved: ${reason(error)}`;
    }
    this.keyBusy = null;
    await this.loadKeys();
    return saved;
  }

  async removeKey(): Promise<void> {
    this.keyBusy = 'remove';
    this.keyError = null;
    try {
      await this.#client.call('keys.remove', { id: VOICE_KEY });
      this.keyCheck = null;
      await this.loadStatus();
    } catch (error) {
      this.keyError = `Not removed: ${reason(error)}`;
    }
    this.keyBusy = null;
    await this.loadKeys();
  }

  async loadVideoNotes(): Promise<void> {
    try {
      this.videoNotes = await this.#client.call<VideoNotesStatus>('videonotes.status');
      this.videoNotesSoon = false;
      this.videoNotesError = null;
    } catch (error) {
      if (isNotBuiltYet(error)) this.videoNotesSoon = true;
      else this.videoNotesError = reason(error);
    }
  }

  async setVideoNotes(enabled: boolean): Promise<void> {
    this.videoNotesBusy = true;
    this.videoNotesError = null;
    try {
      this.videoNotes = await this.#client.call<VideoNotesStatus>('videonotes.setup', { enabled });
    } catch (error) {
      this.videoNotesError = `Couldn't change that: ${reason(error)}`;
    }
    this.videoNotesBusy = false;
  }

  async loadComponents(): Promise<void> {
    this.componentsError = null;
    try {
      this.components = (await this.#client.call<ComponentsAnswer>('components.status')).components ?? [];
    } catch (error) {
      this.components = null;
      this.componentsError = reason(error);
    }
  }

  /** "Done, start making": the setup is finished. Returns why it could not be saved, or null. */
  async finish(): Promise<string | null> {
    try {
      await this.#client.call('setup.done', { done: true });
      return null;
    } catch (error) {
      return reason(error);
    }
  }
}
