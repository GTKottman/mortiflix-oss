import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureStudio, saveConfig } from '../src/studio.mjs';

// A throwaway studio using the demo backend (no Claude, no cost), cleaned up after the test.
export function tempStudio(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mfx-test-'));
  ensureStudio(root);
  saveConfig(root, { backend: 'demo', demoDelayMs: 0, ...config });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
