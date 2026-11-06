// The music plan: the cues along the voice, each with a prompt and settings, and the mix under the voice.
// Making a cue is paid and goes through the queue; everything here is free (listen, ducking, crossfade, approve).
import { isNotBuiltYet } from '../../lib/service/client';
import type { VoiceService } from './mock';
import { cueName } from './review';
import type { MusicCue, MusicPlan } from './types';

export type CueSetting = Partial<Pick<MusicCue, 'prompt' | 'energy' | 'duck_db' | 'crossfade_sec'>>;

export class MusicStore {
  plan = $state<MusicPlan | null>(null);
  /** The service does not do music yet. */
  missing = $state(false);
  error = $state<string | null>(null);
  /** Something the mix is made from changed since this screen opened (a cue, a read, Speed, a pause, a take);
      false again once "Mix under the voice" made a new mix. */
  mixOld = $state(false);
  /** What is happening now: 'set', 'ok', 'plan' or 'mix'. */
  busy = $state<string | null>(null);
  readonly #service: VoiceService;
  readonly #changed: (plan: MusicPlan) => void;

  constructor(service: VoiceService, changed: (plan: MusicPlan) => void) {
    this.#service = service;
    this.#changed = changed;
  }

  get cues(): readonly MusicCue[] {
    return this.plan?.cues ?? [];
  }

  cue(id: string | null): MusicCue | undefined {
    return id ? this.cues.find((c) => c.id === id) : undefined;
  }

  /** At least one cue has been made and is up to date: the rest may be queued, and the mix can be made. */
  get anyMade(): boolean {
    return this.cues.some((c) => c.path && c.state !== 'stale');
  }

  /** The cues still to make (none made, or made from older words or lengths). */
  get toMake(): readonly MusicCue[] {
    return this.cues.filter((c) => !c.path || c.state === 'stale');
  }

  /** What making them costs, in ElevenLabs credits (the service's own per-cue figure). */
  get toMakeCredits(): number {
    return this.toMake.reduce((sum, c) => sum + (c.credits ?? 0), 0);
  }

  /** What Make the music makes now (the service's music.make obeys the same rule): the first music alone; then nothing
   *  until it is heard and OK'd (`wait` says so); then the other cues. `label` is the button's words. */
  get makeNow(): { cues: readonly MusicCue[]; credits: number; label: string | null; wait: string | null } {
    const todo = this.toMake;
    const made = this.cues.filter((c) => c.path && c.state !== 'stale');
    const of = (cues: readonly MusicCue[]) => cues.reduce((sum, c) => sum + (c.credits ?? 0), 0);
    const next = todo[0];
    if (!next) return { cues: [], credits: 0, label: null, wait: null };
    if (!made[0]) {
      const first = todo.slice(0, 1);
      return {
        cues: first,
        credits: of(first),
        label: todo.length > 1 ? `Make ${cueName(next.id)} first` : `Make ${cueName(next.id)}`,
        wait: null,
      };
    }
    if (!this.cues.some((c) => c.state === 'ok')) {
      const heard = cueName(made[0].id);
      return {
        cues: [],
        credits: 0,
        label: null,
        wait: `Hear ${heard} and OK it, then make the other ${todo.length}.`,
      };
    }
    return { cues: todo, credits: of(todo), label: `Make the other ${todo.length}`, wait: null };
  }

  /** The voice step wants music and it isn't all made and approved yet (none planned counts). */
  get missingMusic(): boolean {
    return Boolean(this.plan?.expected) && (!this.cues.length || this.cues.some((c) => c.state !== 'ok'));
  }

  async load(): Promise<void> {
    try {
      const plan = await this.#service.call<MusicPlan>('music.plan.get');
      this.plan = plan;
      this.missing = false;
      this.#changed(plan);
    } catch (error) {
      if (isNotBuiltYet(error)) this.missing = true;
      else this.error = error instanceof Error ? error.message : String(error);
    }
  }

  setCue(id: string, setting: CueSetting): Promise<void> {
    return this.#act('set', async () => {
      await this.#service.call('music.cue.set', { cue: id, ...setting });
      this.mixOld = true;
    });
  }

  approve(id: string): Promise<void> {
    return this.#act('ok', () => this.#service.call('music.cue.ok', { cue: id }));
  }

  planAgain(): Promise<void> {
    return this.#act('plan', async () => {
      await this.#service.call('music.plan.make');
      this.mixOld = true;
    });
  }

  /** Make every cue not made yet: the owner's OK on the cost (step.confirm_cost), which starts the making. */
  makeAll(): Promise<void> {
    return this.#act('make', () => this.#service.call('step.confirm_cost', { step: 'music' }));
  }

  mix(): Promise<void> {
    return this.#act('mix', async () => {
      await this.#service.call('music.mix');
      this.mixOld = false;
    });
  }

  async #act(label: string, work: () => Promise<unknown>): Promise<void> {
    this.busy = label;
    this.error = null;
    try {
      await work();
    } catch (error) {
      const code = (error as { code?: string }).code;
      this.error =
        code === 'no_voice'
          ? "Make the voice first: the music is cut at the voice's scene changes."
          : error instanceof Error
            ? error.message
            : String(error);
    }
    this.busy = null;
    await this.load();
  }
}
