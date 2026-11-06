import { getContext } from 'svelte';
import { Router } from '../router.svelte';
import type { ServiceClient } from '../service/client';
import { Connection } from './connection.svelte';
import { Problems } from './problems.svelte';
import { Project } from './project.svelte';
import { ScreenBar } from './screen-bar.svelte';
import { Settings } from './settings.svelte';
import { UsageStore } from './usage.svelte';

// Everything the shared pieces need, made once in App.svelte and read with the use* helpers below,
// so no component passes the service, the project or the problem list down by hand.

export interface AppContext {
  client: ServiceClient;
  router: Router;
  problems: Problems;
  connection: Connection;
  settings: Settings;
  project: Project;
  usage: UsageStore;
  screenBar: ScreenBar;
}

const KEY = Symbol('mortiflix-app');

export function createAppContext(client: ServiceClient): AppContext {
  const problems = new Problems();
  const project = new Project(client);
  return {
    client,
    router: new Router(),
    problems,
    connection: new Connection(client, problems),
    settings: new Settings(client),
    project,
    usage: new UsageStore(client, project),
    screenBar: new ScreenBar(),
  };
}

/** The context map for mount(App, { context }). */
export const appContextMap = (context: AppContext): Map<symbol, AppContext> => new Map([[KEY, context]]);

export function useApp(): AppContext {
  const context = getContext<AppContext | undefined>(KEY);
  if (!context) throw new Error('The app context is missing: render inside App.svelte.');
  return context;
}

export const useService = (): ServiceClient => useApp().client;
export const useRouter = (): Router => useApp().router;
export const useProblems = (): Problems => useApp().problems;
export const useSettings = (): Settings => useApp().settings;
export const useProject = (): Project => useApp().project;
export const useUsage = (): UsageStore => useApp().usage;
export const useScreenBar = (): ScreenBar => useApp().screenBar;
