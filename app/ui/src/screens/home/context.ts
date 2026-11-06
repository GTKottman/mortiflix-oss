import { getContext, setContext } from 'svelte';
import type { StageId } from '../../lib/stages';
import type { HomeCaller } from './fixture';
import type { HomeProject } from './types';

// What a project's ⋯ menu needs from Home, so the cards and rows do not pass it down by hand.

export interface HomeActions {
  /** The service, or the `?fixture=home` stand-in. */
  client: HomeCaller;
  /** Opens the project at its own stage, or at `stage`. */
  open: (project: HomeProject, stage?: StageId) => void;
  /** Fetches the list again after the menu changed a project. */
  reload: () => void;
  /** The menu deleted a project: Home offers Undo. */
  deleted: (project: HomeProject) => void;
}

const KEY = Symbol('home');

export const provideHome = (actions: HomeActions): HomeActions => setContext(KEY, actions);

export function useHome(): HomeActions {
  const actions = getContext<HomeActions | undefined>(KEY);
  if (!actions) throw new Error('The project menu is only used on Home.');
  return actions;
}
