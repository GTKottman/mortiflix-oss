// G3: all pending stills in ONE Kinetograph render (one bundle, one process), as a render-queue job.
// A "Stills" composition has one frame per line (durationInFrames = N); frame i draws props.lines[i]. The batch is
// rendered as a numbered picture sequence (kgRender sequence) and each element-i.png is moved to its line's file.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { command } from '../platform.mjs';
import { createHash } from 'node:crypto';
import { kgRender } from '../kinetograph.mjs';

export const BATCH_MAX = 400; // the composition's length below
export const STILLS_BATCH_TSX = `import React from 'react';
import { Composition, AbsoluteFill, registerRoot, useCurrentFrame } from 'remotion';
// Written by the studio (svc/stillsbatch.mjs). Composition "Stills": frame i draws props.lines[i] = { kicker, key, text, bg, fg, accent, font }.
const Stills: React.FC<any> = ({ lines }) => {
  const f = useCurrentFrame();
  const { kicker, key: k, text, bg, fg, accent, font } = (lines || [])[f] || {};
  return (
    <AbsoluteFill style={{ background: bg, color: fg, fontFamily: font || 'sans-serif', padding: 120, justifyContent: 'center' }}>
      <div style={{ fontSize: 36, color: accent, marginBottom: 32, letterSpacing: 4 }}>{kicker}</div>
      <div style={{ fontSize: 220, fontWeight: 800, lineHeight: 1, marginBottom: 48 }}>{k}</div>
      <div style={{ width: 160, height: 12, background: accent, borderRadius: 6, marginBottom: 48 }} />
      <div style={{ fontSize: 56, lineHeight: 1.3, maxWidth: 1400, color: fg, opacity: 0.85 }}>{text}</div>
    </AbsoluteFill>
  );
};
// Fixed length: only the frames asked for (--range 0..N-1) are drawn, so a short batch costs a short render.
const Root = () => <Composition id="Stills" component={Stills} width={1920} height={1080} fps={30} durationInFrames={400} defaultProps={{ lines: [] }} />;
registerRoot(Root);
`;

// What a line's picture depends on: when this is unchanged the picture is too, so it is not drawn again.
export const propsHash = (props) => createHash('sha1').update(JSON.stringify([props.kicker, props.key, props.text, props.bg, props.fg, props.accent, props.font])).digest('hex').slice(0, 12);

/**
 * The batch as a render-queue renderer: ({items: [{line, props, output}]}) -> draws every item.
 * `renders` (the studio's RenderQueue) runs it as a job and waits, polling in 120 s slices, so nothing blocks the
 * service; without one it runs in a child process (tests, CLI). Throws on failure.
 */
export function kinetographBatch({ root, work, renders = null, projectId = null, sessionId = null, env = {}, run = null }) {
  return async (items) => {
    if (!items.length) return;
    const vdir = join(work, 'video');
    mkdirSync(join(vdir, 'src'), { recursive: true });
    writeFileSync(join(vdir, 'src', 'stills-batch.tsx'), STILLS_BATCH_TSX);
    const tmp = join(work, 'out', 'stills-batch');
    rmSync(tmp, { recursive: true, force: true });
    const n = items.length;
    const cmd = kgRender({ root, entry: 'src/stills-batch.tsx', composition: 'Stills', output: tmp, sequence: true, frames: [0, n - 1], props: { lines: items.map((i) => i.props) } });
    if (renders) {
      const job = renders.add({ projectId, sessionId, label: `stills (${n})`, argv: ['bash', '-c', cmd], cwd: vdir, env: { ...process.env, ...env } });
      let v = job;
      while (!['done', 'failed'].includes(v.state)) v = await renders.wait(job.id, projectId, 120);
      if (!(v.state === 'done' && v.exit_code === 0)) throw new Error(String(v.output_tail || v.error || 'the stills render failed').slice(-300));
    } else {
      const sh = command('bash', ['-c', cmd]); // Git Bash on Windows
      const r = (run || spawnSync)(sh.file, sh.args, { ...sh.options, cwd: vdir, encoding: 'utf8', timeout: 300_000 });
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'kinetograph failed').slice(-300));
    }
    const pad = Math.max(1, String(n - 1).length);
    items.forEach((it, i) => {
      const src = join(tmp, `element-${String(i).padStart(pad, '0')}.png`);
      if (!existsSync(src)) throw new Error(`the stills render made no picture for ${it.line}`);
      mkdirSync(dirname(it.output), { recursive: true });
      try { renameSync(src, it.output); } catch { copyFileSync(src, it.output); }
    });
    rmSync(tmp, { recursive: true, force: true });
  };
}
