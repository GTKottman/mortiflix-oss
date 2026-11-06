import type { ServiceClient } from '../../lib/service/client';
import type { StepState } from '../../lib/service/types';
import {
  answersFor,
  sessionStartedAt,
  submittedNote,
  submittedQuestions,
  type BriefQuestion,
  type ChatRow,
  type ProjectEvent,
} from './brief';

/** review.submission: what Claude submitted for one step version, whole. */
interface Submission {
  note?: string;
}

const EVENTS_LIMIT = 400;
const CHAT_LIMIT = 60;

/** One step version, so an OK on the brief never greys out the script's OK. */
export const versionKey = (step: StepState): string => `${step.key}:${step.version ?? 0}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The step waiting for the owner's OK (the Brief), what Claude wrote about it, and OK / Fix. */
export class BriefStore {
  note = $state('');
  questions = $state<BriefQuestion[]>([]);
  /** Answers the owner picked or typed; a question not in here takes its suggested answer. */
  picked = $state<Record<string, string>>({});
  loaded = $state(false);
  loadError = $state('');
  sessionStart = $state<number | null>(null);
  sending = $state<'ok' | 'fix' | null>(null);
  error = $state('');
  /** OK went out for this step version ("brief:2"): the service goes on by itself, so OK stays off until it moves. */
  okSentFor = $state<string | null>(null);
  fixSent = $state(false);
  readonly #client: ServiceClient;
  /** The step version last read; picks from another one never carry over. */
  #loadedFor = '';

  constructor(client: ServiceClient) {
    this.#client = client;
  }

  /** Reads what Claude submitted for this step, and when the running session began. */
  async load(step: StepState): Promise<void> {
    const key = versionKey(step);
    if (this.#loadedFor !== key) {
      // A new version: nothing from the old one stays, so OK stays off until this version's questions are read.
      this.#loadedFor = key;
      this.picked = {};
      this.questions = [];
      this.note = '';
      this.loaded = false;
      this.loadError = '';
    }
    try {
      const [events, rows] = await Promise.all([
        this.#client.call<ProjectEvent[]>('project.events', { limit: EVENTS_LIMIT }),
        this.#client.call<ChatRow[]>('chat.history', { limit: CHAT_LIMIT }),
      ]);
      // The whole note from the stored submission; the SUBMITTED event's copy stops at 300 characters, so it is only
      // the fallback for a service without review.submission.
      const whole = await this.#client
        .call<Submission | null>('review.submission', { step: step.key, version: step.version ?? undefined })
        .catch(() => null);
      if (this.#loadedFor !== key) return; // another version was asked for meanwhile: this answer is old
      this.note = whole?.note?.trim() || submittedNote(events, step);
      this.questions = submittedQuestions(rows, step);
      this.sessionStart = sessionStartedAt(events);
      this.loadError = '';
    } catch (error) {
      if (this.#loadedFor !== key) return;
      this.loadError = messageOf(error);
    }
    this.loaded = true;
  }

  /** When the running session began; unknown (null) if the events can't be read. */
  async loadSession(): Promise<void> {
    try {
      this.sessionStart = sessionStartedAt(
        await this.#client.call<ProjectEvent[]>('project.events', { limit: EVENTS_LIMIT }),
      );
    } catch {
      this.sessionStart = null;
    }
  }

  /** OK can go out: the brief was read and every question has an answer (a brief with no questions needs none). */
  get canOk(): boolean {
    return this.loaded && !this.loadError && answersFor(this.questions, this.picked) !== null;
  }

  /**
   * OK. Each answer goes in first (chat.answer), then always the verdict itself (review.respond ok) for the version on
   * screen. The service may already have approved the step on the last answer; it then ignores the verdict. OK never
   * relies on that implicit path (2026-11-02: after a service restart the answers went in and the brief stayed in
   * review).
   */
  async ok(step: StepState): Promise<void> {
    const answers = answersFor(this.questions, this.picked);
    if (!answers) return;
    await this.#run('ok', async () => {
      for (const [question, value] of Object.entries(answers)) {
        await this.#client.call('chat.answer', { question, value });
      }
      await this.#client.call('review.respond', { step: step.key, version: step.version, verdict: 'ok' });
    });
    if (!this.error) this.okSentFor = versionKey(step);
  }

  /** Fix: sends this version back with the owner's words (review.respond changes); Mortiflix writes the next one. */
  async fix(step: StepState, words: string): Promise<boolean> {
    const text = words.trim();
    if (!text) return false;
    await this.#run('fix', async () => {
      await this.#client.call('review.respond', {
        step: step.key,
        version: step.version,
        verdict: 'changes',
        notes: text,
      });
    });
    this.fixSent = !this.error;
    return this.fixSent;
  }

  async #run(kind: 'ok' | 'fix', send: () => Promise<void>): Promise<void> {
    this.sending = kind;
    this.error = '';
    try {
      await send();
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.sending = null;
    }
  }
}
