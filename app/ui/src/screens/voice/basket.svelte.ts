// The queue: everything paid (a re-read, a changed tone, new music) waits here, with its cost, until the owner
// presses Make the queue and confirms. Nothing reaches ElevenLabs before that.
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { ServiceError } from '../../lib/service/client';
import { billingStop, cueName, lineName } from './review';
import type { VoiceService } from './mock';
import type { CostAnswer, VoiceLine } from './types';

export interface LinePatch {
  tags?: string[];
  role?: string;
  stability?: number;
}

export interface QueuedLine {
  /** 'set' = a changed setting (queued only if it needs a new read); 'take' = a plain new read. */
  kind: 'set' | 'take';
  patch: LinePatch;
  /** null while the cost is being worked out. */
  credits: number | null;
  why: string;
}

export interface QueuedCue {
  credits: number;
  seconds: number;
  /** The cost is a guess until a cue has been made and measured. */
  estimate: boolean;
}

export interface BasketDeps {
  service: VoiceService;
  lines: () => readonly VoiceLine[];
  /** The service's own message when ElevenLabs has no key. */
  noKey: () => string | null;
  /** A line was sent for a new read: show it as being made until the new take arrives. */
  sent: (line: VoiceLine | undefined, id: string) => void;
  /** The queue ran (or stopped): reload what it changed. */
  refresh: () => Promise<void>;
  /** The project this queue belongs to, fixed when the screen opened it: every call names it, so a run that goes on
      after the tab switched project never spends in the other project. */
  project?: string | null;
  /** The service's ElevenLabs credits per character (voicemusic.view `credit_rate`); null when not known. */
  creditRate?: () => number | null;
}

const DRY_RUN_WAIT_MS = 300;
const COST_BATCH = 6;
const BILLING = /\b(401|402|429)\b/;

const isBilling = (error: unknown): boolean =>
  error instanceof ServiceError && (error.code === 'billing' || BILLING.test(error.message));

export class Basket {
  readonly lines = new SvelteMap<string, QueuedLine>();
  readonly cues = new SvelteMap<string, QueuedCue>();
  /** Clips whose last make failed. */
  readonly failed = new SvelteSet<string>();
  /** Which item of how many is being made now. */
  making = $state<{ n: number; of: number } | null>(null);
  makingId = $state<string | null>(null);
  /** What went wrong, in plain words; the screen shows it in the Fix it strip. */
  error = $state<string | null>(null);
  /** Stop was pressed (or the screen closed): no further item is sent. The one already sent cannot be called back. */
  stopping = $state(false);

  readonly #deps: BasketDeps;
  readonly #timers = new SvelteMap<string, ReturnType<typeof setTimeout>>();
  /** The latest cost check per line: an older answer that arrives late is ignored. */
  readonly #tokens = new SvelteMap<string, number>();
  #sequence = 0;

  constructor(deps: BasketDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.lines.size + this.cues.size;
  }

  /** The project named on every call: the one captured when this queue was made, never the tab's current one. */
  #params(params: Record<string, unknown>): Record<string, unknown> {
    return this.#deps.project ? { ...params, project: this.#deps.project } : params;
  }

  /** Stops a running queue after the item being made now; that one is already with ElevenLabs. */
  stop(): void {
    if (this.making) this.stopping = true;
  }

  /** The screen is gone or the project changed: stop the run and every pending cost check. */
  dispose(): void {
    this.stop();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Queues a changed setting, then works out whether it needs a paid read and what that costs. */
  stage(id: string, patch: LinePatch): void {
    const key = this.#deps.noKey();
    if (key) {
      this.error = key;
      return;
    }
    const current = this.lines.get(id);
    this.lines.set(id, {
      kind: 'set',
      patch: { ...(current?.kind === 'set' ? current.patch : {}), ...patch },
      credits: null,
      why: 'changed',
    });
    this.#price(id);
  }

  /** Queues plain new reads for these lines, six cost checks at a time. */
  async stageTakes(ids: readonly string[], why: string): Promise<void> {
    const key = this.#deps.noKey();
    if (key) {
      this.error = key;
      return;
    }
    const fresh = ids.filter((id) => !this.lines.has(id));
    for (const id of fresh) this.lines.set(id, { kind: 'take', patch: {}, credits: null, why });
    for (let n = 0; n < fresh.length; n += COST_BATCH) {
      await Promise.all(
        fresh.slice(n, n + COST_BATCH).map(async (id) => {
          const credits = await this.#priceTake(id);
          const item = this.lines.get(id);
          if (item?.kind === 'take') this.lines.set(id, { ...item, credits });
        }),
      );
    }
  }

  /** What a plain new read of this line costs; null (and the reason in `error`) when the service cannot say, so
      the queue never offers to spend an unknown amount. */
  async #priceTake(id: string): Promise<number | null> {
    try {
      const answer = await this.#deps.service.call<CostAnswer>('voice.line.take', this.#params({ line: id }));
      return answer.needs_confirm === false ? 0 : (answer.credits_estimate ?? answer.characters ?? null);
    } catch (error) {
      this.error = this.#costUnknown(id, error);
      return null;
    }
  }

  #costUnknown(id: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `Could not work out the cost of ${lineName(this.#deps.lines(), id)}: ${message}. Take it out of the queue or try again later.`;
  }

  unstage(id: string): void {
    this.failed.delete(id);
    clearTimeout(this.#timers.get(id));
    this.lines.delete(id);
  }

  addCue(id: string, item: QueuedCue): void {
    this.cues.set(id, item);
    this.error = null;
  }

  removeCue(id: string): void {
    this.cues.delete(id);
  }

  clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.lines.clear();
    this.cues.clear();
    this.error = null;
  }

  /** Drops a queued cue that the plan no longer has, and ends its estimate once the real cost is known. */
  syncCues(known: readonly string[], measured: boolean): void {
    for (const [id, item] of [...this.cues]) {
      if (!known.includes(id)) this.cues.delete(id);
      else if (item.estimate && measured) this.cues.set(id, { ...item, estimate: false });
    }
  }

  /** Makes what is queued, one item at a time, and stops at the first failure. Only ever called after the cost prompt. */
  async run(onlyFirst: boolean): Promise<void> {
    const all = [
      ...[...this.lines].map(([id, item]) => ({ cue: false, id, item })),
      ...[...this.cues].map(([id]) => ({ cue: true, id, item: null })),
    ];
    const todo = onlyFirst ? all.slice(0, 1) : all;
    this.error = null;
    this.stopping = false;
    for (const [n, step] of todo.entries()) {
      if (this.stopping) {
        this.error = `Stopped: ${todo.length - n} of ${todo.length} not made, nothing more was sent.`;
        break;
      }
      this.making = { n: n + 1, of: todo.length };
      this.makingId = step.id;
      this.failed.delete(step.id);
      try {
        if (step.cue) {
          await this.#deps.service.call('music.cue.make', this.#params({ cue: step.id, confirm: true }));
          this.cues.delete(step.id);
        } else {
          await this.#makeLine(step.id, step.item);
        }
      } catch (error) {
        this.failed.add(step.id);
        this.error = this.#explain(error, step.cue, step.id);
        break;
      }
    }
    this.making = null;
    this.makingId = null;
    this.stopping = false;
    await this.#deps.refresh();
  }

  async #makeLine(id: string, item: QueuedLine | null): Promise<void> {
    const line = this.#deps.lines().find((l) => l.node === id);
    if (item?.kind === 'set') {
      await this.#deps.service.call('voice.line.set', this.#params({ line: id, ...item.patch, confirm: true }));
    } else {
      await this.#deps.service.call('voice.line.take', this.#params({ line: id, confirm: true }));
    }
    this.#deps.sent(line, id);
    this.lines.delete(id);
  }

  #explain(error: unknown, cue: boolean, id: string): string {
    const message = error instanceof Error ? error.message : String(error);
    if (isBilling(error)) {
      const code = BILLING.exec(message)?.[1] ?? '402';
      const reason = message.replace(/\s*\(?\b(401|402|429)\b\)?/, '').trim() || 'out of credits';
      return billingStop(reason, code);
    }
    const name = cue ? cueName(id) : lineName(this.#deps.lines(), id);
    return `Could not make ${name}: ${message}`;
  }

  /** A dry `voice.line.set` answers `credits` as the CHARACTER count (voicecast.mjs creditsFor); the credits are
      those characters at the service's measured rate, the same sum voicecost.mjs uses for `credits_estimate`.
      Unknown rate: null, so the queue says the cost is unknown instead of showing characters as credits. */
  #setCredits(answer: CostAnswer): number | null {
    if (answer.credits_estimate != null) return answer.credits_estimate;
    const characters = answer.characters ?? answer.credits ?? 0;
    const rate = this.#deps.creditRate?.() ?? null;
    return rate == null ? null : Math.ceil(characters * rate);
  }

  #price(id: string): void {
    clearTimeout(this.#timers.get(id));
    this.#timers.set(
      id,
      setTimeout(async () => {
        const item = this.lines.get(id);
        if (!item || item.kind !== 'set') return;
        const token = ++this.#sequence;
        this.#tokens.set(id, token);
        try {
          const answer = await this.#deps.service.call<CostAnswer>(
            'voice.line.set',
            this.#params({ line: id, ...item.patch, dry: true }),
          );
          if (this.#tokens.get(id) !== token || !this.lines.has(id)) return;
          if (answer.retake) {
            const credits = this.#setCredits(answer);
            this.lines.set(id, { ...item, credits });
            if (credits === null) this.error = this.#costUnknown(id, new Error('the credit rate is not known yet'));
          } else this.lines.delete(id);
        } catch (error) {
          if (this.#tokens.get(id) !== token) return;
          this.error = this.#costUnknown(id, error);
        }
      }, DRY_RUN_WAIT_MS),
    );
  }
}
