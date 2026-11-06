import { bridgeUrl } from '../../lib/base';
import type { HomeCaller } from './fixture';
import { applyChange } from './projects';
import type { HomeProject, ProjectChange, Still } from './types';

// The projects on Home: the list, their first stills, and the live changes. An event patches one project in
// place at once, then the list is fetched again: the event carries no stage, and a new still may be there.

export type Phase = 'loading' | 'ready' | 'error';

export class HomeProjects {
  list = $state<HomeProject[]>([]);
  stills = $state<Record<string, Still>>({});
  phase = $state<Phase>('loading');
  error = $state('');
  /** A refresh failed after a good load: the list on screen may be old. Empty = the last read worked. */
  refreshError = $state('');
  readonly #client: HomeCaller;
  #asked = 0;

  constructor(client: HomeCaller) {
    this.#client = client;
  }

  /** Fetches the list and stills. Only the newest answer counts; a failed refresh keeps the list on screen. */
  async load(): Promise<void> {
    const mine = ++this.#asked;
    try {
      const [list, stills] = await Promise.all([
        this.#client.call<HomeProject[]>('project.list'),
        // fetch resolves on an HTTP error too: only a 2xx body is a stills map. A failed read keeps the stills shown.
        fetch(bridgeUrl('/api/stills'))
          .then((answer) => {
            if (!answer.ok) throw new Error(`stills answered ${answer.status}`);
            return answer.json() as Promise<Record<string, Still>>;
          })
          .catch((): null => null),
      ]);
      if (mine !== this.#asked) return;
      this.list = list;
      if (stills) this.stills = stills;
      this.phase = 'ready';
      this.error = '';
      this.refreshError = '';
    } catch (error) {
      if (mine !== this.#asked) return;
      if (this.phase === 'ready') {
        this.refreshError = error instanceof Error ? error.message : 'unknown error';
        return;
      }
      this.list = [];
      this.phase = 'error';
      this.error = error instanceof Error ? error.message : 'unknown error';
    }
  }

  /** Applies a `project.changed` event, then reloads the list for the stage and stills. */
  async change(change: ProjectChange): Promise<void> {
    const project = this.list.find((p) => p.id === change.id);
    if (project) applyChange(project, change);
    await this.load();
  }
}
