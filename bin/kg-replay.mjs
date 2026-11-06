#!/usr/bin/env node
// Replay mode's stand-in for the Kinetograph CLI (src/kinetograph.mjs kgCommand points here when MFX_REPLAY is set).
// No rendering: `still … -o x.png` copies a recorded still, `render … -o x.mp4` a recorded motion clip, `render …
// --sequence dir` writes recorded stills as element-<n>.png for the asked range. The `render` fault fails it (exit 1).
import { copyFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { replayPack, takeFault, logReplay } from '../src/replay.mjs';

const args = process.argv.slice(2);
const root = process.env.MORTIFLIX_STUDIO;
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
if (args[0] === '--version' || args[0] === 'version') { console.log('kinetograph 0.2.0 (replay stand-in)'); process.exit(0); }
if (takeFault(root, 'render')) { console.error('kinetograph: render failed (replay fault: render)'); process.exit(1); }
const pack = replayPack();
const stillsDir = join(pack.dir, pack.stills || 'stills');
const stills = existsSync(stillsDir) ? readdirSync(stillsDir).filter((f) => f.endsWith('.png')).sort().map((f) => join(stillsDir, f)) : [];
const scenes = (() => { try { return JSON.parse(readFileSync(join(pack.dir, pack.motion?.scenes || 'motion/scenes.json'), 'utf8')); } catch { return []; } })();
const clips = scenes.map((s) => join(pack.dir, s.file)).filter((f) => existsSync(f));
const out = val('-o');
const seq = val('--sequence');
const fail = (m) => { console.error(`kinetograph (replay): ${m}`); process.exit(1); };
if (args[0] === 'still') {
  if (!out || !stills.length) fail('no output or no recorded stills');
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(stills[Math.floor(Math.random() * stills.length)], out);
} else if (args[0] === 'render' && seq) {
  if (!stills.length) fail('no recorded stills');
  const r = String(val('--range') || '0..=0').match(/^(\d+)\.\.=(\d+)$/);
  const [from, to] = r ? [Number(r[1]), Number(r[2])] : [0, 0];
  mkdirSync(seq, { recursive: true });
  const pad = Math.max(1, String(to).length);
  for (let i = from; i <= to; i++) copyFileSync(stills[(i - from) % stills.length], join(seq, `element-${String(i).padStart(pad, '0')}.png`));
} else if (args[0] === 'render' && out) {
  if (!clips.length) fail('no recorded motion clips');
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(clips[0], out);
} else fail(`can't stand in for: ${args.slice(0, 3).join(' ')}`);
logReplay(root, { kind: 'kinetograph', cmd: args[0], out: out || seq });
console.error('rendering frame 1/1');
