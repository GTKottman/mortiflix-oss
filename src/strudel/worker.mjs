// The Strudel evaluator process (doc 28 §2.1). The studio starts it with Node's permission model (read access to the
// Strudel install and this folder only: no writes, no child processes, no network modules loaded) and talks to it over
// stdin/stdout, one JSON line each way. It runs a pattern's text and answers with its notes in ticks.
//   in:  { id, code, bars, prelude?, globals? }
//   out: { id, ok: true, cps, haps: [{ begin, end, value, block, locations: [[start, end], …] }] }   (as headless Chrome
//        gives them; derive.mjs makes notes of them)  |  { id, ok: false, error, line }
// The text runs as in the Strudel REPL: `$:` lines play together (`_$:` is muted), setcps / setcpm set the tempo, and
// the drawing calls (.pianoroll(), .punchcard() …) do nothing, since nothing draws here.
import './hooks.mjs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const MAX_EVENTS = 100_000;
const mod = (name) => import(pathToFileURL(join(dir, 'node_modules', '@strudel', name, 'dist', 'index.mjs')).href);

// Strudel prints a banner and browser warnings on load; stdout is our channel, so they go to stderr.
const out = process.stdout.write.bind(process.stdout);
console.log = console.info = console.warn = (...a) => process.stderr.write(a.join(' ') + '\n');

// A pattern's stray async error (a refused network call, say) must not take the evaluator down.
process.on('uncaughtException', (e) => process.stderr.write(`stray error: ${e.message}\n`));
process.on('unhandledRejection', (e) => process.stderr.write(`stray rejection: ${e?.message || e}\n`));

const core = await mod('core');
const mini = await mod('mini');
const tonal = await mod('tonal');
const { transpiler } = await mod('transpiler');
const noop = () => {};
// The REPL's own globals, per run: the tempo and the `$:` lines.
let cps = 0.5;
let blocks = [];
const setcps = (c) => { cps = Number(c); };
await core.evalScope(core, mini, tonal, {
  samples: noop, soundfont: noop, registerSound: noop, aliasBank: noop, initAudioOnFirstClick: noop, hush: noop,
  setcps, setCps: setcps, setcpm: (m) => setcps(Number(m) / 60), setCpm: (m) => setcps(Number(m) / 60),
});
try { core.registerControl?.('drum'); } catch { /* already there */ }
// Plain JS strings read as mini-notation too (note('c3 e3'), or a string a helper built), as the REPL sets it up.
mini.miniAllStrings();
// `$: x` is x.p('$'); `_$: x` is x.p('_$'). Each line is a block, numbered in order of the text.
core.Pattern.prototype.p = function (id) {
  const muted = typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'));
  blocks.push({ pattern: this, muted });
  return this;
};
for (const m of ['pianoroll', 'punchcard', 'scope', 'tscope', 'fscope', 'spectrum', 'spiral', 'pitchwheel', 'wordfall', 'color', 'colour', 'markcss', 'draw']) {
  for (const name of [m, `_${m}`]) if (!core.Pattern.prototype[name]) core.Pattern.prototype[name] = function () { return this; };
}

// Runs the text: { pattern (all blocks together), list: [{ pattern, block }] }.
// `prelude`: plain JS run first, in the global scope, the way an app's page adds its own helpers before the score
// (Mortiflix Music's voice() and guide()); `globals`: data those helpers read as window.<name>.
globalThis.window = globalThis;
// A prelude may replace a Strudel name (Mortiflix Music's voice() replaces the `voice` control): each run with one gets
// the global scope back as it found it, so the next text sees plain Strudel.
let saved = null;
function restoreGlobals() {
  if (!saved) return;
  for (const k of Object.getOwnPropertyNames(globalThis)) if (!saved.has(k)) { try { delete globalThis[k]; } catch { /* fixed */ } }
  for (const [k, d] of saved) { const now = Object.getOwnPropertyDescriptor(globalThis, k); if (!now || now.value !== d.value || now.get !== d.get) { try { Object.defineProperty(globalThis, k, d); } catch { /* fixed */ } } }
  saved = null;
}
async function run(code, { prelude, globals } = {}) {
  if (prelude || globals) saved = new Map(Object.getOwnPropertyNames(globalThis).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  cps = 0.5;
  blocks = [];
  if (globals) Object.assign(globalThis, globals);
  if (prelude) (0, eval)(String(prelude));
  const { pattern } = await core.evaluate(String(code), transpiler);
  const list = blocks.length ? blocks.map((b, i) => ({ ...b, block: i })).filter((b) => !b.muted) : (pattern ? [{ pattern, block: 0 }] : []);
  if (!list.length || list.some((b) => typeof b.pattern?.queryArc !== 'function')) throw new Error('the text makes no pattern');
  return list;
}

// Every event that starts in [0, bars), with its value as plain data: what headless Chrome returns (lib/headless.mjs).
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'function' ? undefined : x)));
function hapsOf(list, bars) {
  const out = [];
  for (const { pattern, block } of list) {
    for (const h of pattern.queryArc(0, bars, { _cps: cps })) {
      if (!h.hasOnset()) continue;
      out.push({ begin: h.whole.begin.valueOf(), end: h.whole.end.valueOf(), value: plain(h.value), block, locations: (h.context?.locations || []).map((l) => [l.start, l.end]) });
      if (out.length > MAX_EVENTS) throw new Error(`more than ${MAX_EVENTS} events: shorten the range or the pattern`);
    }
  }
  return out;
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    try {
      const list = await run(msg.code, msg);
      out(JSON.stringify({ id: msg.id, ok: true, cps, haps: hapsOf(list, msg.bars) }) + '\n');
    } finally {
      if (msg.prelude || msg.globals) restoreGlobals();
    }
  } catch (e) {
    const lineNo = e.loc?.line ?? (String(e.stack).match(/<anonymous>:(\d+):/)?.[1] ? Number(RegExp.$1) : null);
    out(JSON.stringify({ id: msg.id, ok: false, error: String(e.message || e).split('\n')[0], line: lineNo }) + '\n');
  }
});
out(JSON.stringify({ ready: true }) + '\n');
