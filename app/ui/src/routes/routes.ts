import type { Component } from 'svelte';
import type { Section } from '../lib/components/SectionTabs.svelte';
import { isStageId, stageById, type StageId } from '../lib/stages';

// Every screen of the app, by hash path. A screen registers itself by existing: the folder
// src/screens/<folder>/ with a <Name>Screen.svelte in it is found by import.meta.glob below, so adding a
// screen never touches a shared file. Until a folder exists, its route shows a stub linking to today's page.

/** Folder name = today's page name in web/screens/ (home, new-project, script, voice, …). */
type Folder = string;

export type Route =
  | { kind: 'kit'; title: string }
  | { kind: 'stage'; stage: StageId; title: string; folder: Folder }
  | { kind: 'section'; section: Section; title: string; folder: Folder }
  | { kind: 'missing'; title: string };

export type ScreenModule = { default: Component };

const SCREENS = import.meta.glob<ScreenModule>('../screens/*/*Screen.svelte');

const SECTIONS: Record<string, Route> = {
  '/': { kind: 'section', section: 'projects', title: 'What do you want to make?', folder: 'home' },
  '/new': { kind: 'section', section: 'projects', title: 'New project', folder: 'new-project' },
  '/lessons': { kind: 'section', section: 'lessons', title: 'Lessons', folder: 'lessons' },
  '/assets': { kind: 'section', section: 'projects', title: 'Assets', folder: 'assets' },
  '/settings': { kind: 'section', section: 'settings', title: 'Settings', folder: 'settings' },
  // The kit shows sample numbers and fake states for screenshots: dev server only (Vite: import.meta.env.DEV is
  // false in a production build), like the ?fixture= switches (change log C009).
  ...(import.meta.env.DEV ? { '/kit': { kind: 'kit', title: 'Component kit' } satisfies Route } : {}),
};

export function routeFor(path: string): Route {
  const known = SECTIONS[path];
  if (known) return known;
  const id = path.replace(/^\//, '');
  if (isStageId(id)) return { kind: 'stage', stage: id, title: stageById(id).label, folder: id };
  return { kind: 'missing', title: 'Not found' };
}

/** The screen in src/screens/<folder>/, or null while it has not moved to Svelte yet. */
export function screenFor(folder: Folder): (() => Promise<ScreenModule>) | null {
  const prefix = `../screens/${folder}/`;
  const found = Object.entries(SCREENS).find(([file]) => file.startsWith(prefix));
  return found ? found[1] : null;
}
