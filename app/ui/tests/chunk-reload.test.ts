import { describe, expect, it, vi } from 'vitest';
import {
  isChunkLoadError,
  loadWithReload,
  RELOAD_KEY,
  RELOAD_WINDOW_MS,
  type ReloadDeps,
} from '../src/routes/chunk-reload';

function deps(now = 1_000_000): ReloadDeps & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    reload: vi.fn(),
    now: () => now,
  };
}

const gone = () =>
  Promise.reject(
    new TypeError('Failed to fetch dynamically imported module: /app/assets/VoiceScreen-abc.js'),
  );
const pending = Symbol('pending');
const settle = <T>(p: Promise<T>) => Promise.race([p, new Promise((r) => setTimeout(() => r(pending), 10))]);

describe('chunk reload', () => {
  it("knows the browsers' missing-chunk errors", () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /app/assets/a.css'))).toBe(true);
    expect(isChunkLoadError(new ReferenceError('x is not defined'))).toBe(false);
  });

  it('returns the screen and clears the mark when the import works', async () => {
    const d = deps();
    d.store.set(RELOAD_KEY, '1');
    await expect(loadWithReload(() => Promise.resolve('screen'), d)).resolves.toBe('screen');
    expect(d.store.has(RELOAD_KEY)).toBe(false);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('reloads once on a missing chunk and keeps loading meanwhile', async () => {
    const d = deps();
    expect(await settle(loadWithReload(gone, d))).toBe(pending);
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.store.get(RELOAD_KEY)).toBe('1000000');
  });

  it('shows the error instead of looping when it fails again right after the reload', async () => {
    const d = deps();
    d.store.set(RELOAD_KEY, String(1_000_000 - 5_000));
    await expect(loadWithReload(gone, d)).rejects.toThrow(/dynamically imported module/);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('reloads again for a later build once the window has passed', async () => {
    const d = deps();
    d.store.set(RELOAD_KEY, String(1_000_000 - RELOAD_WINDOW_MS - 1));
    expect(await settle(loadWithReload(gone, d))).toBe(pending);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads for other errors', async () => {
    const d = deps();
    await expect(loadWithReload(() => Promise.reject(new Error('boom')), d)).rejects.toThrow('boom');
    expect(d.reload).not.toHaveBeenCalled();
  });
});
