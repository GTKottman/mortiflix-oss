import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// The bridge (bridge.mjs) serves web/ statically, so the built app lives in web/app/ and is opened at /app/.
// No dev server: build once, or `npm run watch` while working, and reload http://127.0.0.1:4646/app/.
export default defineConfig({
  base: './',
  plugins: [svelte()],
  build: {
    outDir: '../web/app',
    // Empty web/app/ on every build (vite.dev build.emptyOutDir; outDir is outside ui/, so it must be said here):
    // old hashed chunks no longer pile up or ship in the installers. A tab opened before a build that asks for a
    // chunk that is gone reloads once (src/routes/chunk-reload.ts).
    emptyOutDir: true,
    // Fonts come from the bridge's /assets/ folder, which the old screens share.
    rollupOptions: { external: [/^\/assets\//] },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
