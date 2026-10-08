// The shared skills' scripts, run for real on tiny inputs (a fake npm keeps it offline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SETUP = fileURLToPath(new URL('../pipelines/_shared/skills/remotion-motion/setup.mjs', import.meta.url));

test('remotion setup installs once per studio and links every project', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfx-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A stand-in for npm install: a shell script, or on Windows a .cmd (setup.mjs runs npm through cmd.exe there).
  const win = process.platform === 'win32';
  const npm = join(dir, win ? 'fake-npm.cmd' : 'fake-npm');
  writeFileSync(npm, win ? '@echo off\r\nmkdir node_modules\\remotion\r\necho installed>> ..\\installs.log\r\n' : '#!/bin/sh\nmkdir -p node_modules/remotion && echo installed >> ../installs.log\n');
  chmodSync(npm, 0o755);
  const env = { ...process.env, MFX_SHARED: join(dir, 'shared'), MFX_NPM: npm };
  for (const p of ['a', 'b']) {
    const r = spawnSync('node', [SETUP, join(dir, p, 'video')], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, p, 'video', 'src', 'Main.tsx')));
    assert.ok(lstatSync(join(dir, p, 'video', 'node_modules')).isSymbolicLink());
    assert.ok(existsSync(join(dir, p, 'video', 'node_modules', 'remotion')));
  }
  // Installed exactly once, into one shared folder.
  assert.equal(readdirSync(join(dir, 'shared')).filter((n) => n.startsWith('remotion-')).length, 1);
  assert.equal(readFileSync(join(dir, 'shared', 'installs.log'), 'utf8').trim().split('\n').length, 1);
  assert.equal(readlinkSync(join(dir, 'a', 'video', 'node_modules')), readlinkSync(join(dir, 'b', 'video', 'node_modules')));
  // Outside a session: a normal local install.
  const r = spawnSync('node', [SETUP, join(dir, 'c', 'video')], { env: { ...process.env, MFX_NPM: npm, MFX_SHARED: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!lstatSync(join(dir, 'c', 'video', 'node_modules')).isSymbolicLink());
});

test('qc.mjs: a designed end hold passes with --end-hold; a freeze mid-video never does', (t) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('no ffmpeg');
  const dir = mkdtempSync(join(tmpdir(), 'mfx-qc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const QC = fileURLToPath(new URL('../pipelines/_shared/skills/final-pass/qc.mjs', import.meta.url));
  const clip = (name, parts) => {
    const inputs = parts.flatMap((p) => ['-f', 'lavfi', '-i', `${p}=size=320x180:rate=30:duration=2`]);
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', `${parts.map((_, i) => `[${i}]`).join('')}concat=n=${parts.length}:v=1:a=0`, '-pix_fmt', 'yuv420p', join(dir, name)]);
    assert.equal(r.status, 0, String(r.stderr));
  };
  clip('end.mp4', ['testsrc2', 'color']);
  clip('mid.mp4', ['testsrc2', 'color', 'testsrc2']);
  const qc = (file, ...extra) => spawnSync('node', [QC, join(dir, file), ...extra, '--sheet', join(dir, `${file}.png`), '--json', join(dir, `${file}.json`)], { encoding: 'utf8' });
  assert.equal(qc('end.mp4').status, 1);
  const held = qc('end.mp4', '--end-hold');
  assert.equal(held.status, 0, held.stdout);
  assert.match(held.stdout, /end hold 2 s/);
  assert.equal(qc('mid.mp4', '--end-hold').status, 1);
});
