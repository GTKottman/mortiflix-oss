import { isNotBuiltYet } from '../../lib/service/client';
import type { Problems } from '../../lib/stores/problems.svelte';
import { clock } from '../../lib/time';
import { plural } from '../../lib/words';
import type { SoundApi } from './api';
import { cuesToSignOff, isUnmade, liveCues, shotAfter, shotToOpen, shotToPrice, stopNote } from './sound';
import type {
  Cue,
  CueChange,
  MakeAnswer,
  MakeScope,
  MotionProgress,
  PlanShot,
  ShotMedia,
  SoundPlan,
} from './types';

// The Sound screen's state: the sound list from the service, which shot and sound are open, what is being made.

export type Mode = 'loading' | 'plan' | 'noplan' | 'coming' | 'error';

const REFRESH_WHILE_MAKING_MS = 3000;
const ERROR = 'sound-err';
const BILLING = 'sound-billing';
/** A background reload failed; cleared by the next one that works. */
const RELOAD = 'sound-reload';

export class SoundState {
  mode = $state<Mode>('loading');
  plan = $state<SoundPlan | null>(null);
  error = $state('');
  canPlan = $state(false);
  /** The service's reason it can't list the sounds yet ('' = none given). */
  cantPlanWhy = $state('');
  /** When the service was last asked (for "Checked at …" after Check again). */
  checkedAt = $state(0);
  motion = $state<MotionProgress | null>(null);
  shotId = $state('');
  cueId = $state<string | null>(null);
  /** What is being saved right now, in words ("Saving"), or empty. */
  busy = $state('');
  /** When the sound list was asked for, while Mortiflix is listing; 0 otherwise. */
  listingSince = $state(0);
  /** The sounds were listed and the service found none to list. */
  listedNone = $state(false);
  /** Sounds are being made: how many in all, how many were still to make at the start, and since when. */
  making = $state<{ total: number; start: number; since: number } | null>(null);
  /** Stop was pressed: the make ends after the sound being made now. */
  stopping = $state(false);
  /** The open shot's picture; undefined while it is being asked for, null when there is none. */
  media = $state<{ shot: string; media: ShotMedia | null | undefined } | null>(null);
  readonly #api: SoundApi;
  readonly #problems: Problems;
  readonly #wantedShot: string | null;
  #poll: ReturnType<typeof setInterval> | undefined;
  /** Each load() gets the next number; an older answer that lands after a newer one is dropped. */
  #latest = 0;

  constructor(api: SoundApi, problems: Problems, wantedShot: string | null) {
    this.#api = api;
    this.#problems = problems;
    this.#wantedShot = wantedShot;
  }

  get shot(): PlanShot | undefined {
    return this.plan?.shots.find((s) => s.id === this.shotId) ?? this.plan?.shots[0];
  }

  /** The open shot's sounds, in time order. */
  get cues(): Cue[] {
    const shot = this.shot;
    return shot && this.plan ? this.plan.cues.filter((cue) => cue.shot === shot.id) : [];
  }

  /** The open sound: the picked one, else the shot's first. */
  get cue(): Cue | undefined {
    return this.cues.find((cue) => cue.id === this.cueId) ?? this.cues[0];
  }

  /** The open shot's sounds that are not cut. */
  get live(): Cue[] {
    return this.shot && this.plan ? liveCues(this.plan, this.shot.id) : [];
  }

  async load(quiet = false): Promise<void> {
    const mine = ++this.#latest;
    if (!quiet) this.error = '';
    try {
      const [{ plan, canPlan, why }, motion] = await Promise.all([this.#api.plan(), this.#api.motion()]);
      if (mine !== this.#latest) return; // a newer load started: this answer is stale
      this.canPlan = canPlan;
      this.cantPlanWhy = why ?? '';
      this.checkedAt = Date.now();
      this.motion = motion;
      this.plan = plan;
      this.mode = plan ? 'plan' : 'noplan';
      this.#problems.clear(RELOAD);
    } catch (error) {
      if (mine !== this.#latest) return;
      // A background reload (while making, after a save) that fails keeps the list on screen and says so.
      if (quiet && this.mode === 'plan') {
        this.#problems.raise({
          id: RELOAD,
          kind: 'bad',
          text: `Couldn't refresh the sounds: ${messageOf(error)}`,
        });
      } else {
        this.mode = isNotBuiltYet(error) ? 'coming' : 'error';
        this.error = messageOf(error);
      }
    }
    const plan = this.plan;
    if (plan) {
      this.shotId = shotToOpen(plan, this.shotId, this.#wantedShot);
      if (!plan.cues.some((cue) => cue.id === this.cueId)) this.cueId = null;
    }
    void this.loadMedia();
  }

  selectShot(id: string): void {
    this.shotId = id;
    this.cueId = null;
    this.media = null;
    void this.loadMedia();
  }

  selectCue(id: string): void {
    this.cueId = id;
  }

  /** Runs one change to a sound, shows what failed in the Fix it strip, and reloads. True when it worked. */
  async act(label: string, work: () => Promise<void>): Promise<boolean> {
    this.busy = label;
    this.#problems.clear(ERROR);
    let done = true;
    try {
      await work();
    } catch (error) {
      done = false;
      this.#problems.raise({ id: ERROR, kind: 'bad', text: messageOf(error) });
    }
    this.busy = '';
    await this.load(true);
    return done;
  }

  change(cue: Cue, change: CueChange): Promise<boolean> {
    return this.act('Saving', () => this.#api.change(cue.id, change));
  }

  signOff(cue: Cue): Promise<boolean> {
    return this.act('Saving', () => this.#api.signOff(cue.id));
  }

  /** Mixes the sounds into the voice and music (free); answers one sentence for the menu. */
  async mix(): Promise<string> {
    try {
      const answer = await this.#api.mix();
      const length = answer.seconds ? ` · ${clock(answer.seconds)}` : '';
      return `Mixed ${plural(answer.sounds, 'sound')} into the voice and music${length}.`;
    } catch (error) {
      return `Not mixed: ${messageOf(error)}`;
    }
  }

  cut(cue: Cue, cut: boolean): Promise<boolean> {
    return this.act('Saving', () => this.#api.cut(cue.id, cut));
  }

  async listTheSounds(): Promise<boolean> {
    this.listingSince = Date.now();
    this.listedNone = false;
    const done = await this.act('Listing the sounds', () => this.#api.makePlan());
    this.listingSince = 0;
    this.listedNone = done && this.mode === 'noplan';
    return done;
  }

  /** Signs off every made sound in the open shot, then opens the next shot. */
  signOffShot(): Promise<boolean> {
    const shot = this.shot;
    const plan = this.plan;
    return this.act('Saving', async () => {
      if (!shot || !plan) return;
      for (const cue of cuesToSignOff(this.cues)) await this.#api.signOff(cue.id);
      const next = shotAfter(plan, shot.id);
      if (next) this.selectShot(next.id);
    });
  }

  /** What making everything, and making one shot, would cost. Nothing is spent. */
  async quote(): Promise<{ all: MakeAnswer; one: { answer: MakeAnswer; shot: PlanShot } | null } | null> {
    const plan = this.plan;
    if (!plan) return null;
    let all: MakeAnswer;
    try {
      all = await this.#api.quote({ all: true });
    } catch (error) {
      this.#problems.raise({ id: ERROR, kind: 'bad', text: messageOf(error) });
      return null;
    }
    // A second price question only when "Test shot N first" is a real, smaller step: the shot's own price must be
    // asked (the service pays a confirm only for a price it gave, paidgate.mjs takeQuote), but not when the whole
    // make is one sound or every sound to make sits in that shot.
    const testShot = all.calls > 1 ? shotToPrice(plan, this.shotId) : undefined;
    const inShot = new Set(plan.cues.filter((c) => c.shot === testShot?.id).map((c) => c.id));
    const subset = Boolean(testShot) && (all.cues ?? []).some((c) => !inShot.has(c.id));
    if (!testShot || !subset) return { all, one: null };
    try {
      return { all, one: { answer: await this.#api.quote({ shot: testShot.id }), shot: testShot } };
    } catch {
      return { all, one: null }; // the test step is left out; the whole price still stands (it was dropped before)
    }
  }

  /** Makes the sounds. Only called after the owner saw the cost and said yes. Sounds appear as they land. */
  async make(scope: MakeScope, total: number): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    this.making = { total, start: plan.cues.filter(isUnmade).length, since: Date.now() };
    this.#problems.clear(ERROR);
    this.#problems.clear(BILLING);
    this.#poll = setInterval(() => void this.load(true), REFRESH_WHILE_MAKING_MS);
    try {
      const result = await this.#api.make(scope);
      this.#reportStop(result, total);
      const first = result.made?.[0];
      const cue = first ? plan.cues.find((c) => c.id === first) : undefined;
      if (cue) {
        this.shotId = cue.shot;
        this.cueId = cue.id;
      }
    } catch (error) {
      this.#problems.raise({ id: ERROR, kind: 'bad', text: messageOf(error) });
    }
    clearInterval(this.#poll);
    this.#poll = undefined;
    this.making = null;
    this.stopping = false;
    await this.load(true);
  }

  /** Asks the service to stop the running make after the current sound (sfx.cancel). */
  async stop(): Promise<void> {
    if (!this.making || this.stopping) return;
    this.stopping = true;
    try {
      await this.#api.cancel();
    } catch (error) {
      this.stopping = false;
      this.#problems.raise({ id: ERROR, kind: 'bad', text: messageOf(error) });
    }
  }

  dispose(): void {
    clearInterval(this.#poll);
    this.#problems.clear(ERROR);
    this.#problems.clear(BILLING);
    this.#problems.clear(RELOAD);
  }

  #reportStop(result: MakeAnswer, total: number): void {
    const note = stopNote(result, total);
    if (note) this.#problems.raise({ id: note.billing ? BILLING : ERROR, kind: 'bad', text: note.text });
  }

  async loadMedia(): Promise<void> {
    const shot = this.shot;
    if (!shot || this.mode !== 'plan' || this.media?.shot === shot.id) return;
    // the approved Motion clip first (the service names it); else the canvas shot node of this shot or its beat
    if (shot.clip?.path) {
      this.media = { shot: shot.id, media: { kind: 'video', ...shot.clip } };
      return;
    }
    const node = this.motion?.nodes.find(
      (n) => n.id === shot.id || (shot.beat ? n.beat === shot.beat : n.beat === shot.id),
    )?.id;
    this.media = { shot: shot.id, media: undefined };
    const media = node ? await this.#api.media(node) : null;
    if (this.media?.shot === shot.id) this.media = { shot: shot.id, media };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}
