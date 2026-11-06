// Who plays whom: the cast, saved by the service. Until the service has a cast, one narrator (the fallback voice).
import type { VoiceService } from './mock';
import { roleName } from './roles';
import type { CastAnswer, CastMember } from './types';

export interface CastNote {
  text: string;
  role: string;
  /** The cast as it was, so Undo can put it back. */
  before: CastMember[];
}

function withoutEngine(member: CastMember): CastMember {
  const copy = { ...member };
  delete copy.engine;
  return copy;
}

export class CastStore {
  answer = $state<CastAnswer | null>(null);
  note = $state<CastNote | null>(null);
  /** Why the cast could not load, in the service's words. */
  failure = $state<string | null>(null);
  readonly #service: VoiceService;
  readonly #speaker: () => string | undefined;

  constructor(service: VoiceService, speaker: () => string | undefined) {
    this.#service = service;
    this.#speaker = speaker;
  }

  /** The service has a cast to show and change. */
  get ready(): boolean {
    return this.answer !== null;
  }

  get members(): CastMember[] {
    if (this.answer?.cast.length) return this.answer.cast;
    const fallback = this.answer?.fallback;
    return [{ ...fallback, role: 'narrator', name: fallback?.name || this.#speaker() || 'Voice' }];
  }

  member(role: string): CastMember | undefined {
    return this.members.find((m) => m.role === role);
  }

  /** "Narrator · Mark" and the voice's own name apart, for lists. */
  speakerOf(role: string): { role: string; name: string } {
    const member = this.member(role);
    const fallbackName = role === 'narrator' ? (this.#speaker() ?? '') : '';
    return { role: roleName(role), name: member?.name || fallbackName };
  }

  async load(): Promise<void> {
    try {
      this.answer = await this.#service.call<CastAnswer>('cast.get');
      this.failure = null;
    } catch (error) {
      this.answer = null;
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }

  /** Saves a whole new cast. Throws the service's message when it refuses. */
  async save(next: readonly CastMember[], note: { text: string; role: string } | null): Promise<void> {
    const before = this.members.map(withoutEngine);
    await this.#service.call('cast.set', { cast: next.map(withoutEngine) });
    this.answer = await this.#service.call<CastAnswer>('cast.get');
    if (note) this.note = { ...note, before };
  }
}
