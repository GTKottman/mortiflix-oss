import { pauseView, runPause, type PauseAction } from '../pause';
import type { Stage } from '../stages';
import type { Project } from '../stores/project.svelte';
import {
  failedWords,
  waitingWords,
  workHere,
  type Drain,
  type PieceWhy,
  type Queued,
  type WorkReport,
} from './waiting';

/** Anything with the service's `call` and `on` (the app's ServiceClient). */
interface Client {
  call<T>(type: string, given?: Record<string, unknown>): Promise<T>;
  on<T = unknown>(event: string, listener: (data: T) => void): () => void;
}

/**
 * Whether the service is really working on this project's stage now. `work.get` answers for this tab's project (the
 * runner session included: `running` = the project has a session); the `work.active` push only follows the project
 * the service has open, which may be another tab's, so it is read again on every push and every 10 s.
 * `start()` returns the stop function (for onMount / $effect). On a fixture it is always on.
 */
export const REREAD_WORK_MS = 10_000;

export class ActiveWork {
  #work = $state<WorkReport | null>(null);
  #known = $state(false);
  /** What Resume answered, or why it could not. */
  said = $state('');
  busy = $state(false);
  #client: Client;
  #project: Project;
  #stage: Stage;
  #fixture: boolean;

  constructor(client: Client, project: Project, stage: Stage, fixture = false) {
    this.#client = client;
    this.#project = project;
    this.#stage = stage;
    this.#fixture = fixture;
  }

  /** True while the service reports work for this project, in this stage. */
  get here(): boolean {
    return this.#fixture || workHere(this.#work, this.#project.id, this.#stage);
  }

  /** The project stopped on a problem: its own words (for "Failed: …" on a piece that is not made); '' = it did not. */
  get failed(): string {
    if (this.#fixture || this.#project.state !== 'paused') return '';
    return failedWords(
      this.#project.needsYou,
      pauseView(this.#project.state, this.#project.needsYou)?.text ?? '',
    );
  }

  /** Everything a piece that is not made needs to say why; `what` names the stage's pieces ("the scenes"). */
  why(what: string): PieceWhy {
    return {
      here: this.here,
      failed: this.failed,
      waiting: this.idle ? waitingWords(this.#stage, this.#project.statuses, what, this.queued) : null,
    };
  }

  /** The service answered and nothing runs here: only then may the screen say it waits. */
  get idle(): boolean {
    return !this.#fixture && this.#known && !this.here;
  }

  /** Queued for a session slot: how many projects are ahead (0 = next) and the drained restart it waits for; null when
   *  it isn't queued. */
  get queued(): Queued | null {
    if (this.#project.state !== 'queued') return null;
    return { ahead: this.#work?.queue?.ahead ?? 0, drain: this.drain };
  }

  /** A drained restart under way (the studio starts no new work until it is done); null when there is none. */
  get drain(): Drain | null {
    return this.#work?.drain?.draining ? this.#work.drain : null;
  }

  /** The button that gets a stopped project going again: Start (draft), the pause's own action, else Resume. */
  get action(): PauseAction | null {
    // queued: it starts by itself when a slot frees; Resume would answer "not paused (queued)"
    // cancelled = stopped: Resume carries on from where it stopped (Stop is not final, owner 2026-11-03)
    if (['delivered', 'queued'].includes(this.#project.state ?? '')) return null;
    return (
      pauseView(this.#project.state, this.#project.needsYou)?.action ?? { label: 'Resume', run: 'resume' }
    );
  }

  /** Latest-wins: the timer, push events and resume() can read at once; a pushed report also outdates reads. */
  #reads = 0;

  async read(): Promise<void> {
    if (this.#fixture || !this.#project.id) return;
    const ticket = ++this.#reads;
    try {
      const work = await this.#client.call<WorkReport>('work.get');
      if (ticket !== this.#reads) return;
      this.#work = work;
      this.#known = true;
    } catch {
      /* the next read tries again; meanwhile the screen claims neither working nor waiting */
    }
  }

  /** The quieter second button: "Let the AI take over" when the service offers it. */
  get second(): PauseAction | null {
    return pauseView(this.#project.state, this.#project.needsYou)?.second ?? null;
  }

  /** Runs the main action, or the second one ("Let the AI take over") with `second`. */
  async resume(second = false): Promise<void> {
    const action = second ? this.second : this.action;
    const id = this.#project.id;
    if (!action || !id || this.busy) return;
    this.busy = true;
    this.said = '';
    try {
      this.said = await runPause(action.run, {
        call: (type, params) => this.#client.call(type, params),
        project: id,
        openVoiceSettings: () => void (location.hash = '#/settings?focus=voice'),
        ...({
          openStage: (stage: string) => void (location.hash = `#/${stage}`),
          need: this.#project.needsYou,
        } as object),
      });
      await this.read();
    } catch (error) {
      this.said = `Could not ${action.label.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.busy = false;
    }
  }

  start(): () => void {
    if (this.#fixture) return () => {};
    void this.read();
    const timer = setInterval(() => void this.read(), REREAD_WORK_MS);
    const stopPush = this.#client.on<WorkReport>('work.active', (work) => {
      if (work.project && work.project === this.#project.id) {
        this.#reads++; // a read still on its way is older than this push
        this.#work = work;
        this.#known = true;
      } else void this.read();
    });
    // a drained restart starting (or one project finishing): read again so queued work says so at once
    const stopDrain = this.#client.on('service.drain', () => void this.read());
    return () => {
      clearInterval(timer);
      stopPush();
      stopDrain();
    };
  }
}
