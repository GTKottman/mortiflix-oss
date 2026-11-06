#!/usr/bin/env node
// The studio's own copy of the real instruments the music engine plays (VCSL, the Versilian Community Sample Library,
// CC0). Strudel can load VCSL from GitHub, but an offline render starts before a large sample has downloaded, so the
// notes come out silent (moon test, 2026-10-19): the engine serves this local copy instead (lib/headless.mjs, /samples/).
//
//   node samples.mjs fetch <dir> [instrument ...]   download (once) into <dir>/vcsl/ and write <dir>/vcsl.json
//   node samples.mjs list                           the instruments the studio uses
//   node samples.mjs catalog                        every instrument each library has (VCSL, VSCO 2)
// An instrument named vsco2_… comes from VSCO 2 Community Edition (CC0, the map vsco2-map.json next to this file,
// built from the library's file names) into <dir>/vsco2/ and <dir>/vsco2.json; every other name from VCSL.
//
// Files are stored as 16-bit 44.1 kHz WAV. vcsl.json keeps Strudel's sample-map format with _base "/samples/vcsl/".
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MAP = 'https://raw.githubusercontent.com/felixroos/dough-samples/main/vcsl.json';
export const INSTRUMENTS = ['steinway', 'harp', 'vibraphone', 'vibraphone_bowed', 'kalimba', 'marimba', 'glockenspiel', 'handbells',
  'tubularbells', 'recorder_alto_sus', 'bassdrum1', 'clap', 'shaker_small', 'tom2_mallet', 'clash'];
const LIBS = {
  vcsl: { file: 'vcsl', licence: 'VCSL, the Versilian Community Sample Library (CC0, public domain): https://github.com/sgossner/VCSL' },
  vsco2: { file: 'vsco2', licence: 'VSCO 2 Community Edition, the Versilian Studios Chamber Orchestra (CC0, public domain): https://github.com/sgossner/VSCO-2-CE' },
};
const VSCO2_MAP = join(dirname(fileURLToPath(import.meta.url)), 'vsco2-map.json');
const libOf = (name) => (name.startsWith('vsco2_') ? 'vsco2' : 'vcsl');
const mapOf = async (lib) => (lib === 'vsco2' ? JSON.parse(readFileSync(VSCO2_MAP, 'utf8')) : (await fetch(MAP)).json());

const [cmd, dir, ...names] = process.argv.slice(2);
if (cmd === 'list') { console.log(INSTRUMENTS.join(' ')); process.exit(0); }
if (cmd === 'catalog') {
  for (const lib of Object.keys(LIBS)) console.log(`${lib} (${LIBS[lib].licence}):\n  ${Object.keys(await mapOf(lib)).filter((k) => !k.startsWith('_')).sort().join(' ')}`);
  process.exit(0);
}
if (cmd !== 'fetch' || !dir) { console.error('usage: samples.mjs fetch <dir> [instrument ...] | list | catalog'); process.exit(1); }

const want = names.length ? names : INSTRUMENTS;
for (const lib of Object.keys(LIBS)) {
  const mine = want.filter((n) => libOf(n) === lib);
  if (mine.length) await fetchLib(lib, mine);
}

async function fetchLib(lib, want) {
const { file, licence: LICENCE } = LIBS[lib];
const map = await mapOf(lib);
const base = map._base;
// a fetch adds to the map already there (fetching one instrument never drops the others)
let had = {};
try { had = JSON.parse(readFileSync(join(dir, `${file}.json`), 'utf8')); } catch { /* the first fetch */ }
const out = { ...had, _base: `/samples/${file}/` };
const jobs = [];
for (const name of want) {
  const entry = map[name];
  if (!entry) { console.error(`✖ ${lib} has no "${name}"`); process.exitCode = 1; continue; }
  const local = (rel, i) => `${name}/${String(i).padStart(3, '0')}.wav`;
  if (Array.isArray(entry)) out[name] = entry.map((rel, i) => { jobs.push([base + rel, local(rel, i)]); return local(rel, i); });
  else out[name] = Object.fromEntries(Object.entries(entry).map(([note, v], i) => { const rel = Array.isArray(v) ? v[0] : v; jobs.push([base + rel, local(rel, i)]); return [note, local(rel, i)]; }));
}
const root = join(dir, file);
let done = 0; let got = 0; const missing = new Set();
const one = async ([url, rel]) => {
  const dest = join(root, rel);
  if (existsSync(dest)) { done++; return; }
  mkdirSync(dirname(dest), { recursive: true });
  const r = await fetch(url.replace(/ /g, '%20'));
  if (!r.ok) { missing.add(rel); console.log(`! ${r.status}: ${url} (left out: the map points at a file VCSL doesn't have)`); return; }
  const tmp = `${dest}.src`;
  writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  const c = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-c:a', 'pcm_s16le', '-ar', '44100', `${dest}.part.wav`]);
  rmSync(tmp, { force: true });
  if (c.status !== 0) throw new Error(`ffmpeg: ${String(c.stderr).slice(-200)}`);
  renameSync(`${dest}.part.wav`, dest);
  done++; got++;
};
const queue = [...jobs];
await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
for (const [k, v] of Object.entries(out)) {
  if (k === '_base') continue;
  if (Array.isArray(v)) out[k] = v.filter((rel) => !missing.has(rel));
  else out[k] = Object.fromEntries(Object.entries(v).filter(([, rel]) => !missing.has(rel)));
  if (!Object.keys(out[k]).length) { delete out[k]; console.log(`! ${k}: no files, left out`); }
}
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${file}.json`), `${JSON.stringify(out, null, 1)}\n`);
const sources = join(dir, 'SOURCES.md');
const others = existsSync(sources) ? readFileSync(sources, 'utf8').split('\n## ').slice(1).filter((x) => !x.startsWith(`${file}\n`)).map((x) => `## ${x.trim()}`) : [];
writeFileSync(sources, `# Samples\n\n${[...others, `## ${file}\n\n${LICENCE}\n\nInstruments: ${Object.keys(out).filter((k) => k !== '_base').join(', ')}`].join('\n\n')}\n`);
console.log(`✔ ${done} files (${got} downloaded now) for ${Object.keys(out).length - 1} instruments in ${root}; map ${join(dir, `${file}.json`)}`);
}
