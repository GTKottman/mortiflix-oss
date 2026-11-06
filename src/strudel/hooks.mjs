// Two packaging problems keep Strudel 1.2.6 from loading in Node; both are fixed here at resolve time, without touching
// the installed packages (doc 28 §2.1):
// - @kabelsalat/web only declares an IIFE "main"; its ES module build sits next to it as index.mjs.
// - @tonaljs packages (abc-notation 4.9.2 and others) name dist/index.js, but ship only index.cjs / index.mjs.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@kabelsalat/web') {
      const r = nextResolve(specifier, context);
      return { ...r, url: r.url.replace(/index\.js$/, 'index.mjs'), format: 'module' };
    }
    if (!specifier.startsWith('@tonaljs/')) return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      const want = String(e.message).match(/Cannot find (?:module|package) '([^']+)'/)?.[1];
      if (!want?.endsWith('index.js')) throw e;
      const alt = want.replace(/index\.js$/, 'index.mjs');
      const file = alt.startsWith('file:') ? fileURLToPath(alt) : alt;
      if (!existsSync(file)) throw e;
      return { url: pathToFileURL(file).href, format: 'module', shortCircuit: true };
    }
  },
});
