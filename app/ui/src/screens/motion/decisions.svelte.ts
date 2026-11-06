import { isNotBuiltYet } from '../../lib/service/client';
import { plural } from '../../lib/words';
import type { MotionSession } from './motion.svelte';
import type { RestAnswer } from './types';
import { PROBLEM, reason, SOON } from './words';

export type Dialog = 'fix' | 'approve' | null;

/** The decisions on the scene on view: Request fix, Approve, and making the rest of the scenes. Each call
 *  shows what is being sent in `busy` and reloads the scenes after. */
export class Decisions {
  dialog = $state<Dialog>(null);
  rest = $state<RestAnswer | null>(null);
  /** What is being sent right now, in words; empty = nothing. */
  busy = $state('');
  readonly #session: MotionSession;

  constructor(session: MotionSession) {
    this.#session = session;
  }

  askFix(): void {
    const session = this.#session;
    // the same rule as the button (canDecide): not while the clip would not load or Motion is not built
    if (!session.unresolved.length || !session.canDecide) return;
    this.dialog = 'fix';
  }

  /** Enter or Approve scene: always asks first. Approving starts the next scene's Claude session, so a stray Enter
      only opens the question (whose first, focused button is the safe one); the dialog's Approve button approves. */
  askApprove(): void {
    const session = this.#session;
    if (!session.scene || !session.canDecide) return;
    this.dialog = 'approve';
  }

  async sendFix(): Promise<void> {
    const session = this.#session;
    // Notes can sit on more than one shot of the scene (the tablet marks any of them): send each shot's.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway local for de-duplication, not state
    const nodes = [...new Set(session.unresolved.map((note) => note.node))];
    if (!nodes.length || this.busy) return;
    const count = session.unresolved.length;
    await this.#run(`◌ Sending ${plural(count, 'note')} as one fix`, 'The notes were not sent', async () => {
      // one notes.send per shot (the service takes one node); a failure part way says which were already sent, those
      // fixes are running
      let sent = 0;
      for (const node of nodes) {
        try {
          await session.api.sendNotes(node);
        } catch (error) {
          if (!sent) throw error;
          throw new Error(
            `${reason(error)}. The notes of ${plural(sent, 'shot')} of ${nodes.length} were sent already and are being fixed`,
            { cause: error },
          );
        }
        sent++;
      }
      session.picked = null;
      session.compare = false;
    });
  }

  /** `remakeNext`: the next scene is made again with the notes, and the owner waits for it. */
  async approve(remakeNext = false): Promise<void> {
    const session = this.#session;
    const beat = session.beat;
    if (this.busy || !beat) return;
    await this.#run(`◌ Approving scene ${session.index + 1}`, 'The scene was not approved', async () => {
      const answer = await session.api.approve(beat, remakeNext);
      if (answer.next) {
        session.active = answer.next;
        session.select(answer.next);
      }
    });
  }

  /** "Make remaining scenes": asks the service what that means; the dialog shows its answer. */
  async askRest(): Promise<void> {
    const session = this.#session;
    try {
      const answer = await session.api.restOfTheScenes(false);
      if (answer.needs_confirm) this.rest = answer;
      else {
        // nothing to start (lessons.mjs sceneAll: the rest are already made together, or one scene is left)
        session.raise(
          'Nothing was started: the other scenes are already being made, or this is the last one.',
        );
        await session.load();
      }
    } catch (error) {
      session.raise(`Could not check: ${reason(error)}`);
    }
  }

  async makeRest(): Promise<void> {
    const session = this.#session;
    this.rest = null;
    await this.#run('◌ Starting all the scenes', 'The scenes were not started', async () => {
      await session.api.restOfTheScenes(true);
    });
  }

  async #run(label: string, failed: string, work: () => Promise<void>): Promise<void> {
    const session = this.#session;
    this.busy = label;
    session.problems.clear(PROBLEM);
    try {
      await work();
    } catch (error) {
      session.raise(isNotBuiltYet(error) ? SOON : `${failed}: ${reason(error)}`);
    }
    this.busy = '';
    await session.load();
  }
}
