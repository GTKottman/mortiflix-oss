import type { Problems } from '../../lib/stores/problems.svelte';
import type { FinishApi } from './api';
import { blockerFor, pathFor } from './finish';
import type { Check, FilmInfo, FinalStatus } from './types';

// The finished video's state for the Finish screen: what the service says, polled while it renders, and the
// few plain sentences that go to the Fix it strip.

const POLL_MS = 2000;

export class FinalVideo {
  status = $state<FinalStatus>({ state: 'none' });
  film = $state<FilmInfo | null>(null);
  checks = $state<Check[] | null>(null);
  /** The file was made but is no longer in the studio folder. */
  lost = $state(false);
  /** The Make button was pressed and the service has not answered yet. */
  starting = $state(false);
  /** Cancel was pressed and the service has not answered yet. */
  stopping = $state(false);
  /** The first answer has arrived. */
  loaded = $state(false);
  /** checks.run failed: nothing was checked (never shown as a pass). */
  checksError = $state<string | null>(null);
  /** The kept sounds and how many are not OK'd on Sound (the film takes them anyway); null = unknown. */
  sounds = $state<{ kept: number; notOk: number } | null>(null);
  readonly #api: FinishApi;
  readonly #problems: Problems;
  readonly #go: (path: string) => void;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(api: FinishApi, problems: Problems, go: (path: string) => void) {
    this.#api = api;
    this.#problems = problems;
    this.#go = go;
  }

  get blocker() {
    return blockerFor(this.film, this.checks);
  }

  /** There is a file to play: made, or made before something changed. */
  get readable(): boolean {
    return this.status.state === 'done' || this.status.state === 'stale';
  }

  get playSrc(): string | undefined {
    return this.readable && !this.lost ? this.#api.playSrc(this.status) : undefined;
  }

  get posterSrc(): string | undefined {
    return this.film ? this.#api.posterSrc(this.film) : undefined;
  }

  async start(): Promise<void> {
    void this.#loadFilm();
    void this.#loadSounds();
    await this.refresh();
    await this.#loadChecks();
  }

  async refresh(): Promise<void> {
    const was = this.status.state;
    try {
      this.status = await this.#api.status();
      this.#problems.clear('finish-status');
    } catch (error) {
      this.#problems.raise({
        id: 'finish-status',
        kind: 'bad',
        text: `Couldn't read the state of the video. ${messageOf(error)}`,
        fix: { label: 'Try again', run: async () => void (await this.refresh()) },
      });
      return;
    } finally {
      this.loaded = true;
    }
    // A stale video still has a file, so only a state without one forgets that the file went missing.
    if (!this.readable) this.lost = false;
    this.#poll(this.status.state === 'rendering');
    // A render that ended changes the shots, the receipt and the checks: read them again.
    if (was === 'rendering' && this.status.state !== 'rendering') {
      void this.#loadFilm();
      void this.#loadChecks();
      void this.#loadSounds();
    }
  }

  async make(): Promise<void> {
    this.starting = true;
    this.lost = false;
    this.#problems.clear('finish-make');
    try {
      await this.#api.make();
    } catch (error) {
      this.#problems.raise({
        id: 'finish-make',
        kind: 'bad',
        text: `The video couldn't be started. ${messageOf(error)}`,
        fix: { label: 'Try again', run: async () => void (await this.make()) },
      });
    }
    this.starting = false;
    await this.refresh();
  }

  async cancel(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.#problems.clear('finish-make');
    try {
      const cancelled = await this.#api.cancel();
      if (cancelled === false) {
        this.#problems.raise({
          id: 'finish-make',
          kind: 'warn',
          text: 'Nothing was stopped: the video was not being made any more.',
        });
      }
    } catch (error) {
      this.#problems.raise({
        id: 'finish-make',
        kind: 'bad',
        text: `Couldn't stop it. ${messageOf(error)}`,
        fix: { label: 'Try again', run: async () => void (await this.cancel()) },
      });
    }
    this.stopping = false;
    await this.refresh();
  }

  openInArtCraft(): Promise<void> {
    return this.#api.openInArtCraft();
  }

  /** Puts the blocker, the last failure and a missing file in the Fix it strip, or takes them out. */
  publishProblems(): void {
    const blocker = this.blocker;
    const toBlocker = blocker
      ? { label: blocker.label, run: async () => void this.#go(pathFor(blocker.target)) }
      : undefined;
    if (blocker && toBlocker) {
      this.#problems.raise({ id: 'finish-block', kind: 'warn', text: blocker.text, fix: toBlocker });
    } else this.#problems.clear('finish-block');

    if (this.status.error) {
      this.#problems.raise({
        id: 'finish-error',
        kind: 'bad',
        text: `The last try to make the video failed. ${this.status.error}`,
        fix: toBlocker ?? { label: 'Try again', run: async () => void (await this.make()) },
      });
    } else this.#problems.clear('finish-error');

    // checks that did not run, said as not run (they were silently skipped: nothing blocked, nothing said)
    const unchecked = (this.checks ?? []).filter((check) => check.checked === false);
    if (this.checksError || unchecked.length) {
      this.#problems.raise({
        id: 'finish-checks',
        kind: 'warn',
        text: this.checksError
          ? `The checks could not run, so nothing was checked. ${this.checksError}`
          : `Not checked: ${unchecked.map((check) => `${check.key} (${check.reason || check.note || 'could not look'})`).join('; ')}.`,
      });
    } else this.#problems.clear('finish-checks');

    // the final-pass sound check (final.status audio_check): it was read by the service and never shown
    const audio = this.status.audio_check;
    if (this.readable && audio && !audio.pass && audio.problems.length) {
      this.#problems.raise({
        id: 'finish-audio',
        kind: 'warn',
        text: `The film's sound: ${audio.problems.join('; ')}.`,
      });
    } else this.#problems.clear('finish-audio');

    // Sound OKs are not a gate in the service: the film takes every kept sound, OK'd or not. Said, not blocked.
    const sounds = this.sounds;
    if (sounds && sounds.notOk) {
      this.#problems.raise({
        id: 'finish-sound',
        kind: 'warn',
        text: `${sounds.notOk} of ${sounds.kept} sounds are not OK'd on Sound yet. The video takes them as they are.`,
        fix: { label: 'Go to Sound ›', run: async () => void this.#go('/sound') },
      });
    } else this.#problems.clear('finish-sound');

    if (this.lost) {
      this.#problems.raise({
        id: 'finish-lost',
        kind: 'bad',
        text: 'The finished video file is missing from the studio folder.',
        fix: { label: 'Make it again', run: async () => void (await this.make()) },
      });
    } else this.#problems.clear('finish-lost');
  }

  /** Leaves the screen: stops polling and takes this screen's problems out of the strip. */
  dispose(): void {
    this.#poll(false);
    for (const id of [
      'finish-status',
      'finish-make',
      'finish-block',
      'finish-error',
      'finish-lost',
      'finish-info',
      'finish-checks',
      'finish-audio',
      'finish-sound',
    ]) {
      this.#problems.clear(id);
    }
  }

  async #loadFilm(): Promise<void> {
    try {
      this.film = await this.#api.film();
      this.#problems.clear('finish-info');
    } catch (error) {
      this.#problems.raise({
        id: 'finish-info',
        kind: 'bad',
        text: `Couldn't read the film. ${messageOf(error)}`,
      });
    }
  }

  async #loadChecks(): Promise<void> {
    try {
      this.checks = await this.#api.checks();
      this.checksError = null;
    } catch (error) {
      this.checks = null;
      this.checksError = messageOf(error);
    }
  }

  async #loadSounds(): Promise<void> {
    this.sounds = (await this.#api.sounds?.()) ?? null;
  }

  #poll(on: boolean): void {
    if (on && !this.#timer) this.#timer = setInterval(() => void this.refresh(), POLL_MS);
    if (!on && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}
