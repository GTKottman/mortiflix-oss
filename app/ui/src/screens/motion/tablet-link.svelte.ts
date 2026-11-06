import { isNotBuiltYet } from '../../lib/service/client';
import type { VideoNotesStatus } from '../../lib/review/types';
import type { MotionSession } from './motion.svelte';
import { tabletReachable } from './tablet';
import { PROBLEM, reason } from './words';

const REACH = 'tablet';
const SYNC = 'tablet-sync';

/** The owner's tablet: whether it can reach this PC, whether its scenes are in step, and sending a scene again. */
export class TabletLink {
  status = $state<VideoNotesStatus | null>(null);
  readonly #session: MotionSession;

  constructor(session: MotionSession) {
    this.#session = session;
  }

  async refresh(): Promise<void> {
    this.status = await this.#session.api.tablet();
    this.#raiseReach();
    await this.checkSync();
  }

  #raiseReach(): void {
    const { problems, api } = this.#session;
    const status = this.status;
    if (!status?.enabled || tabletReachable(status)) {
      problems.clear(REACH);
      return;
    }
    problems.raise({
      id: REACH,
      kind: 'warn',
      text: ['Your tablet cannot reach this PC.', status.problems?.[0], 'The notes already here stay.']
        .filter(Boolean)
        .join(' '),
      fix: {
        run: async () => {
          this.status = await api.tablet();
          if (!tabletReachable(this.status))
            throw new Error(this.status?.problems?.[0] ?? 'It still cannot be reached');
          return 'The tablet can reach this PC again.';
        },
      },
    });
  }

  async checkSync(): Promise<void> {
    const { problems, api, projectId } = this.#session;
    // Called unawaited on every sync event: a failed check keeps the last answer instead of throwing.
    const found = await api.syncCheck(projectId()).catch(() => undefined);
    if (found === undefined) return;
    if (!found) {
      problems.clear(SYNC);
      return;
    }
    problems.raise({
      id: SYNC,
      kind: 'warn',
      text: found.text,
      fix: found.fix
        ? {
            run: async () => {
              const said = await api.syncFix(projectId());
              await this.checkSync();
              return said;
            },
          }
        : null,
    });
  }

  async sendScene(): Promise<void> {
    const session = this.#session;
    if (!session.beat) return;
    try {
      await session.api.sendToTablet(session.projectId(), session.beat);
      session.problems.clear(PROBLEM);
    } catch (error) {
      session.raise(
        isNotBuiltYet(error)
          ? 'Sending a scene to the tablet again comes in the next studio update.'
          : `The scene was not sent again: ${reason(error)}`,
      );
      return;
    }
    // Sent: a failed status refresh after it must not say it was not sent.
    await this.refresh().catch(() => undefined);
  }

  async stop(): Promise<void> {
    const session = this.#session;
    try {
      await session.api.stopTablet();
    } catch (error) {
      session.raise(`Could not stop: ${reason(error)}`);
      return;
    }
    await this.refresh().catch(() => undefined);
  }
}
