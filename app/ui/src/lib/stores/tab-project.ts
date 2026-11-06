import { pageParam } from '../page';

// Which project THIS tab works on. Several tabs (and several directors) use the studio at once, and the service keeps
// one open project for all of them, so the tab decides for itself: the address (?project=) first, then this tab's
// sessionStorage. localStorage is only the default for a brand-new window that has neither.

const KEY = 'mfx.project';

/** The project this tab starts on, or null (a new window with nothing remembered). */
export function initialTabProject(): string | null {
  return pageParam('project') ?? readStore(() => sessionStorage) ?? readStore(() => localStorage);
}

/** Remembers the tab's project: the address, this tab's sessionStorage, and the default for new windows. */
export function rememberTabProject(id: string): void {
  writeStore(() => sessionStorage, id);
  writeStore(() => localStorage, id);
  if (pageParam('project') === id) return;
  const url = new URL(location.href);
  url.searchParams.set('project', id);
  history.replaceState(history.state, '', url);
}

function readStore(store: () => Storage): string | null {
  try {
    return store().getItem(KEY);
  } catch {
    return null;
  }
}

function writeStore(store: () => Storage, id: string): void {
  try {
    store().setItem(KEY, id);
  } catch {
    // private mode or full: the address still holds the project
  }
}
