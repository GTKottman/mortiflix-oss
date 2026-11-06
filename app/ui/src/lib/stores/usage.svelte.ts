import { isNotBuiltYet, type ServiceClient } from '../service/client';
import type { ProjectSummary } from '../service/types';
import { STAGES } from '../stages';
import { normalizeUsage, projectTitles, type UsageNames } from '../usage/normalize';
import type { Usage, UsageRange } from '../usage/types';
import type { Project } from './project.svelte';

// The token counter's numbers. `today` feeds the coin; `shown` is the range picked in the dropdown.
// Reloads on the service's `usage.changed`. An older service without `usage.get` shows "not available": never
// invented numbers (client.ts isNotBuiltYet).

/** What the owner reads when the service has no usage counter. */
export const USAGE_NOT_AVAILABLE = 'Not available: this service has no usage counter yet.';

const reason = (error: unknown): string =>
  isNotBuiltYet(error) ? USAGE_NOT_AVAILABLE : error instanceof Error ? error.message : 'unknown error';

// The service names a stage by any of its keys ("voiceMusic", "styleFrames"); all read as the stage's label.
const STAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ...STAGES.flatMap((s) => [s.id, ...s.keys].map((key): [string, string] => [key, s.label])),
  ['artcraft', 'ArtCraft'],
]);

export class UsageStore {
  today = $state<Usage | null>(null);
  shown = $state<Usage | null>(null);
  range = $state<UsageRange>('today');
  loading = $state(false);
  error = $state<string | null>(null);
  /** Why the coin's own read (today) failed, or null. The coin shows "–" meanwhile. */
  todayError = $state<string | null>(null);
  readonly #client: ServiceClient;
  readonly #project: Project;
  #projectNames: Promise<ReadonlyMap<string, string>> | null = null;
  /** Latest-wins ticket for `today`: a burst of usage.changed must not let an older answer land last. */
  #todayLoads = 0;
  /** Latest-wins ticket for the panel: only the newest `show` may set shown, error and loading. */
  #shows = 0;

  constructor(client: ServiceClient, project: Project) {
    this.#client = client;
    this.#project = project;
    client.on('usage.changed', () => void this.refresh());
    // A new or renamed project: read the titles again next time.
    client.on('project.changed', () => (this.#projectNames = null));
  }

  async refresh(): Promise<void> {
    await Promise.all([this.loadToday(), this.shown ? this.show(this.range) : null]);
  }

  async loadToday(): Promise<void> {
    const ticket = ++this.#todayLoads;
    try {
      const usage = await this.#fetch('today', null);
      if (ticket !== this.#todayLoads) return;
      this.today = usage;
      this.todayError = null;
    } catch (error) {
      if (ticket !== this.#todayLoads) return;
      console.warn('usage.get today', error);
      this.todayError = reason(error);
    }
  }

  async show(range: UsageRange): Promise<void> {
    this.range = range;
    this.error = null;
    // The coin failed its first read: opening the panel (or Retry) reads it again, so it does not stay "–".
    if (!this.today) void this.loadToday();
    const project = range === 'project' ? this.#project.id : null;
    if (range === 'project' && !project) {
      // "This project" with no project open: nothing to read (the panel says "No project open"). Never all projects.
      this.#shows++;
      this.shown = null;
      this.loading = false;
      return;
    }
    this.loading = true;
    const ticket = ++this.#shows;
    try {
      const usage = await this.#fetch(range, project);
      if (ticket === this.#shows) this.shown = usage;
    } catch (error) {
      if (ticket === this.#shows) this.error = reason(error);
    } finally {
      if (ticket === this.#shows) this.loading = false;
    }
  }

  async #fetch(range: UsageRange, project: string | null): Promise<Usage> {
    const params = range === 'project' ? { range: 'all', project } : { range };
    const [raw, projects] = await Promise.all([this.#client.call('usage.get', params), this.#names()]);
    const names: UsageNames = { projects, stages: STAGE_NAMES };
    return normalizeUsage(raw, range, project, names);
  }

  /** Project titles for by_project and high scores, read once. A failed read is not kept: the next one tries again. */
  #names(): Promise<ReadonlyMap<string, string>> {
    if (!this.#projectNames) {
      const names = this.#client
        .call<ProjectSummary[]>('project.list')
        .then(projectTitles)
        .catch((): ReadonlyMap<string, string> => {
          if (this.#projectNames === names) this.#projectNames = null;
          return new Map();
        });
      this.#projectNames = names;
    }
    return this.#projectNames;
  }
}
