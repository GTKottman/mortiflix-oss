// A new build replaces web/app/, so a tab opened before it may ask for a screen chunk that no longer exists
// (VoiceScreen-<old hash>.js 404). The fix is to reload once and pick up the new index.html. A sessionStorage
// mark stops a reload loop: if the screen still fails right after that reload, the caller shows an error.

/** sessionStorage key holding the time of the last automatic reload. */
export const RELOAD_KEY = 'mfx.chunk-reload';
/** A failure this soon after an automatic reload is not retried again. */
export const RELOAD_WINDOW_MS = 60_000;

export interface ReloadDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload: () => void;
  now: () => number;
}

const defaultDeps = (): ReloadDeps => ({
  storage: sessionStorage,
  reload: () => location.reload(),
  now: () => Date.now(),
});

/** True for the errors browsers throw when a dynamic import or its preload cannot be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}

/** Runs a lazy import; on a missing chunk, reloads the page once (the returned promise then never settles). */
export async function loadWithReload<T>(
  load: () => Promise<T>,
  deps: ReloadDeps = defaultDeps(),
): Promise<T> {
  try {
    const loaded = await load();
    deps.storage.removeItem(RELOAD_KEY);
    return loaded;
  } catch (error) {
    if (!isChunkLoadError(error)) throw error;
    const last = Number(deps.storage.getItem(RELOAD_KEY) ?? 0);
    if (last && deps.now() - last < RELOAD_WINDOW_MS) throw error;
    deps.storage.setItem(RELOAD_KEY, String(deps.now()));
    deps.reload();
    return new Promise<T>(() => {});
  }
}
