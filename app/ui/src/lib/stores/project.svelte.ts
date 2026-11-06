import type { ServiceClient } from '../service/client';
import type { NeedsYou, ProjectSummary, ServiceState, StageStatus } from '../service/types';
import { initialTabProject, rememberTabProject } from './tab-project';

// This tab's project: id, title and stage statuses, live from the service (events 'status' for this id only).

interface StatusEvent {
  project?: string;
  title?: string;
  stages?: StageStatus[];
  state?: string | null;
  needs_you?: NeedsYou | null;
}

interface ChangedEvent {
  id?: string;
  state?: string | null;
  needs_you?: NeedsYou | null;
}

export class Project {
  id = $state<string | null>(null);
  title = $state('');
  statuses = $state<StageStatus[]>([]);
  /** The service's project state: draft, queued, waiting, paused, delivered, cancelled. */
  state = $state<string | null>(null);
  needsYou = $state<NeedsYou | null>(null);
  readonly #client: ServiceClient;
  #loads = 0;

  /** `id` starts as the tab's own project (address, then this tab's sessionStorage), before the service answers. */
  constructor(client: ServiceClient, startId: string | null = initialTabProject()) {
    this.#client = client;
    this.id = startId;
    client.setProject(() => this.id);
    client.on<StatusEvent>('status', (event) => {
      if ((event.project ?? null) !== this.id) return;
      if (event.stages) this.statuses = event.stages;
      if (event.title) this.title = event.title;
      if ('state' in event) this.#setState(event.state, event.needs_you);
    });
    client.on<ChangedEvent>('project.changed', (event) => {
      if (event.id && event.id === this.id) this.#setState(event.state, event.needs_you);
    });
  }

  /**
   * Opens this tab's project: `wanted` (Home, New project), else the tab's own (address, sessionStorage), else the
   * service's open one for a brand-new window. Every call after this carries the id (ServiceClient.setProject), so
   * another tab opening its project later never moves this one.
   */
  async load(wanted?: string): Promise<void> {
    const ticket = ++this.#loads;
    const want = wanted ?? this.id ?? initialTabProject();
    let id = want;
    let state: ServiceState | null = null;
    if (want) {
      // project.open only tells the service this project is watched (its status events keep coming); it no longer
      // decides what this tab shows. `id` moves only after it succeeded (below): a project that failed to open never
      // becomes this tab's project, so no call carries its id.
      await this.#client.call('project.open', { id: want });
    } else {
      state = await this.#client.call<ServiceState>('state.get');
      id = state.project ? projectIdOf(state.project) : null;
    }
    if (ticket !== this.#loads) return;
    if (id !== this.id) {
      this.statuses = [];
      this.title = '';
    }
    this.id = id;
    this.#setState(state?.state, state?.needs_you);
    if (!id) return;
    rememberTabProject(id);
    const [statuses, projects] = await Promise.all([
      this.#client.call<StageStatus[]>('stage.status', { project: id }),
      this.#client.call<ProjectSummary[]>('project.list'),
    ]);
    if (ticket !== this.#loads || id !== this.id) return;
    this.statuses = statuses;
    const mine = projects.find((p) => p.id === id);
    this.title = mine?.title ?? '';
    if (mine) this.#setState(mine.state, mine.needs_you);
  }

  #setState(state: string | null | undefined, needsYou: NeedsYou | null | undefined): void {
    this.state = state ?? null;
    this.needsYou = needsYou ?? null;
  }
}

/** state.get's project: an id, or the whole project record an older service sends. */
function projectIdOf(project: unknown): string | null {
  if (typeof project === 'string') return project;
  if (project && typeof project === 'object' && typeof (project as { id?: unknown }).id === 'string')
    return (project as { id: string }).id;
  return null;
}
