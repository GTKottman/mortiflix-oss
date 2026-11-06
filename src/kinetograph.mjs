// Kinetograph: the studio's video renderer. A GPU engine (Rust, as a Node addon) that renders the same Remotion-API
// TSX projects with no Chrome: a project's `remotion` and `@remotion/*` imports resolve to Kinetograph's own
// implementation, so a project needs no node_modules of its own. github.com/GTKottman/kinetograph (a fork of
// 0xS4N4TG/kinetograph; PolyForm Small Business 1.0.0).
//
// One shared install per studio, in tools/kinetograph. It comes from the owner's fork build when one is here: the npm
// tarballs the fork's `node scripts/pack-local.mjs` writes (its packs/ folder), found in MFX_KINETOGRAPH_PACKS, config.json
// tools.kinetographPacks (either may name the fork's folder) or tools/downloads/kinetograph. With none, it is the
// pinned npm release (KINETOGRAPH_VERSION). Nothing is compiled here either way. A local build of the fork can also be
// run in place: MFX_KINETOGRAPH (or config.json tools.kinetograph) naming its cli.js, its package folder
// (node_modules/kinetograph or packages/cli) or the fork's own folder.
//
// kgRender and kgStill return shell command strings for the render queue's `bash -c` lines. They never pass --json:
// it silences the `rendering frame N/T` progress line on stderr, which the queue reads for its percent.
import { replayOn, KG_STUB } from './replay.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, studioRoot } from './studio.mjs';

// The fork's release. The fork's main is ahead of it (motion tracking, onVideoFrame, SVG foreignObject and gradient
// fixes, a bundled monospace font); none of the studio's renders need those. Move this when a newer release is out.
export const KINETOGRAPH_VERSION = '0.2.0';
export const KINETOGRAPH_NODE = 22;

// The prebuilt addon (and its ffmpeg) for this computer; Kinetograph publishes no others.
const NATIVE = { 'linux-x64': 'linux-x64-gnu', 'darwin-arm64': 'darwin-arm64', 'win32-x64': 'win32-x64-msvc' };
export const nativePackage = (platform = process.platform, arch = process.arch) => {
  const p = NATIVE[`${platform}-${arch}`];
  return p ? `@kinetographdev/native-${p}` : null;
};

export const kgDir = (root) => join(root, 'tools', 'kinetograph');
const modules = (root) => join(kgDir(root), 'node_modules');
// What tools/kinetograph was installed from: written by setup for a fork build ({source: 'fork', commit, branch, packs}).
export const kgSourceFile = (root) => join(kgDir(root), 'source.json');
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * The owner's fork build as npm tarballs, if there is one: {dir, build, files: {<package name>: <tarball path>}}, where
 * build is the pack's BUILD.json (commit, branch, platform). It needs the CLI's tarball and this computer's platform
 * package; a folder that holds a packs/ folder (the fork's checkout) counts as that packs/ folder.
 */
export function kgPacks(root) {
  let saved = null;
  try { saved = loadConfig(root).tools?.kinetographPacks || null; } catch { saved = null; }
  const native = nativePackage();
  for (const d of [process.env.MFX_KINETOGRAPH_PACKS, saved, join(root, 'tools', 'downloads', 'kinetograph')].filter(Boolean)) {
    const dir = existsSync(join(d, 'packs', 'BUILD.json')) ? join(d, 'packs') : d;
    const build = readJson(join(dir, 'BUILD.json'));
    if (!build || !Array.isArray(build.packages)) continue;
    const files = {};
    for (const p of build.packages) if (p && p.name && p.file && existsSync(join(dir, p.file))) files[p.name] = join(dir, p.file);
    if (files.kinetograph && native && files[native]) return { dir, build, files };
  }
  return null;
}
const installedCli = (root) => join(modules(root), 'kinetograph', 'dist', 'cli.js');
// Where npm puts the `kinetograph` command; sessions get it on their PATH.
export const kgBinDir = (root) => join(modules(root), '.bin');

// A named place as its cli.js: the file itself, a package folder (dist/cli.js) or the fork's folder.
function asCli(p) {
  let dir = false;
  try { dir = statSync(p).isDirectory(); } catch { return null; }
  if (!dir) return p;
  return [join(p, 'dist', 'cli.js'), join(p, 'packages', 'cli', 'dist', 'cli.js')].find((f) => existsSync(f)) || null;
}

// The cli.js to run: one named by the owner (a local build of the fork), else the studio's install.
function cliPath(root) {
  let saved = null;
  try { saved = loadConfig(root).tools?.kinetograph || null; } catch { saved = null; }
  return [process.env.MFX_KINETOGRAPH, saved, installedCli(root)].filter(Boolean).map(asCli).find((p) => p && existsSync(p)) || null;
}

const readVersion = (pkg) => readJson(pkg)?.version || null;

// Where `npx --yes kinetograph@<version>` keeps its copy: ~/.npm/_npx/<hash>/node_modules/kinetograph. Running that
// cli.js with this Node skips npx's own start-up (4.2 s against 1.16 s for the same inspect, plan G1).
// Only a copy of exactly the pinned version with its addon beside it counts; null when there is none.
export function npxCacheCli(version = KINETOGRAPH_VERSION, { cacheDir } = {}) {
  const base = join(cacheDir || process.env.npm_config_cache || join(homedir(), '.npm'), '_npx');
  let dirs = [];
  try { dirs = readdirSync(base); } catch { return null; }
  const native = nativePackage();
  for (const d of dirs) {
    const nm = join(base, d, 'node_modules');
    const cli = join(nm, 'kinetograph', 'dist', 'cli.js');
    if (!existsSync(cli) || readVersion(join(nm, 'kinetograph', 'package.json')) !== version) continue;
    if (native && !existsSync(join(nm, native, 'package.json'))) continue;
    return cli;
  }
  return null;
}

const resolved = new Map();
let warned = false;

/**
 * How the CLI is run, once per studio and process: {argv, source, version}. In order: the studio's install (or the
 * owner's local build) -> the npx cache copy of the pinned version -> npx itself (slow: warns once). The result is
 * remembered while its cli.js still exists. `warn` is where the npx warning goes (default console.warn).
 * Reuse this for any process that runs the CLI directly (motion data's inspect calls): spawn argv[0] with argv.slice(1).
 */
export function kgResolve(root, { warn = (m) => console.warn(m) } = {}) {
  const hit = resolved.get(root);
  if (hit && (hit.source === 'npx' || existsSync(hit.argv[1]))) return hit;
  let r;
  const cli = cliPath(root);
  if (cli) r = { argv: [process.execPath, cli], source: 'install', version: readVersion(join(cli, '..', '..', 'package.json')) };
  else {
    const cached = npxCacheCli();
    if (cached) r = { argv: [process.execPath, cached], source: 'npx-cache', version: KINETOGRAPH_VERSION };
    else {
      if (!warned) { warned = true; warn(`Kinetograph is not installed in ${kgDir(root)} and has no npx cache copy: every process pays npx start-up (about 3 s). Install it (components.install).`); }
      r = { argv: ['npx', '--yes', `kinetograph@${KINETOGRAPH_VERSION}`], source: 'npx', version: KINETOGRAPH_VERSION };
    }
  }
  resolved.set(root, r);
  return r;
}
export const kgResetResolve = () => { resolved.clear(); warned = false; seqSupport.clear(); };

// Whether the resolved CLI can write numbered pictures itself (`render --sequence <dir>`, the owner's fork build; npm 0.2.0
// can't). Asked once per CLI (`render --help` lists the flag) and remembered. MFX_KG_SEQUENCE=1|0 forces the answer.
const seqSupport = new Map();
export function kgHasSequence(root = studioRoot()) {
  const forced = process.env.MFX_KG_SEQUENCE;
  if (forced === '1' || forced === '0') return forced === '1';
  const r = kgResolve(root);
  const key = r.argv.join('\0');
  if (!seqSupport.has(key)) {
    const out = spawnSync(r.argv[0], [...r.argv.slice(1), 'render', '--help'], { encoding: 'utf8', timeout: 30_000 });
    seqSupport.set(key, out.status === 0 && /--sequence\b/.test(`${out.stdout || ''}${out.stderr || ''}`));
  }
  return seqSupport.get(key);
}

// How the CLI is run, as an argv prefix: this Node and the cli.js, or (nothing found) npx with the pinned version.
// replay mode (src/replay.mjs): the recorded-clip stand-in, never the real renderer
export const kgCommand = (root) => (replayOn() ? [process.execPath, KG_STUB] : [...kgResolve(root).argv]);

// Whether it can render here: the CLI, its addon for this computer, and Node 22 or newer. No process is started.
export function kgStatus(root) {
  const node = Number(process.versions.node.split('.')[0]);
  const native = nativePackage();
  if (!native) return { ok: false, version: null, detail: `no renderer build for ${process.platform}-${process.arch} (Linux x64, macOS arm64 and Windows x64 only)` };
  const cli = cliPath(root);
  if (!cli) return { ok: false, version: null, detail: 'not installed' };
  const version = readVersion(join(cli, '..', '..', 'package.json'));
  if (node < KINETOGRAPH_NODE) return { ok: false, version, path: cli, detail: `The renderer ${version} needs Node ${KINETOGRAPH_NODE} or newer (this is ${process.version})` };
  // The studio's install must have the addon; a local build of the fork finds its own.
  if (cli === installedCli(root) && !existsSync(join(modules(root), native, 'package.json'))) return { ok: false, version, path: cli, detail: `${native} is missing: reinstall` };
  if (cli !== installedCli(root)) return { ok: true, version, path: cli, source: 'local', detail: `Renderer ${version} (built in)` };
  // The studio's install: the fork build it came from, or the npm release. A fork build that is here and not the one
  // installed (newer, or the install is still npm's) asks for a reinstall.
  const from = readJson(kgSourceFile(root));
  const packs = kgPacks(root);
  if (from?.source === 'fork') {
    const name = `Renderer ${version} (build ${from.branch || '?'} ${String(from.commit || '').slice(0, 8)})`;
    const stale = packs && packs.build.commit !== from.commit ? `: ${packs.dir} holds ${String(packs.build.commit).slice(0, 8)}, reinstall` : '';
    return { ok: !stale, version, path: cli, source: 'fork', commit: from.commit || null, detail: `${name}${stale}` };
  }
  if (packs) return { ok: false, version, path: cli, source: 'npm', detail: `Renderer ${version} from npm, but a newer build is in ${packs.dir}: reinstall` };
  const pinned = version === KINETOGRAPH_VERSION ? '' : ` (expected ${KINETOGRAPH_VERSION}: reinstall)`;
  return { ok: !pinned, version, path: cli, source: 'npm', detail: `Renderer ${version}${pinned}` };
}

// The ffmpeg that turns a render into numbered pictures: KINETOGRAPH_FFMPEG, else the one on the PATH (the studio needs
// it anyway: doctor checks it). Not the ffmpeg that comes with the addon: that build only encodes Kinetograph's videos
// (no PNG encoder, no image2 muxer, no ProRes decoder), so it can't read the ProRes file back.
export function kgFfmpeg() {
  return [process.env.KINETOGRAPH_FFMPEG].filter(Boolean).find((p) => existsSync(p)) || 'ffmpeg';
}

// ---- command lines ----

// One word for bash: left bare when it's plain, else in single quotes.
export const shq = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

// --props takes the JSON itself. Remotion took a file too: a file's JSON is read by the shell when the command runs.
function propsArg(props) {
  if (props === undefined || props === null || props === '') return [];
  if (typeof props === 'object') return ['--props', shq(JSON.stringify(props))];
  const s = String(props).trim();
  return s.startsWith('{') ? ['--props', shq(s)] : ['--props', `"$(cat ${shq(s)})"`];
}

// Remotion's codecs as Kinetograph's: h264, h265, prores, vp9, gif.
const CODECS = { h264: 'h264', 'h264-mkv': 'h264', h265: 'h265', prores: 'prores', vp9: 'vp9', vp8: 'vp9', gif: 'gif' };

// [from, to] (both shown, as Remotion's --frames=a-b), or one frame -> Kinetograph's inclusive range.
function range(frames) {
  if (frames === undefined || frames === null) return null;
  const [from, to] = Array.isArray(frames) ? frames : [frames, frames];
  return { from: Number(from), to: Number(to ?? from) };
}

/**
 * A video render (or, with `sequence`, numbered pictures in the `output` folder) as one shell command, run in the
 * project folder. Options as Remotion names them:
 *   codec        h264 (default), h265, prores, vp9, gif; vp8 renders as vp9 and h264-mkv as h264 (Kinetograph writes
 *                .mp4, .mov, .webm and .gif only)
 *   crf, pixelFormat, scale, concurrency   as Remotion's
 *   imageFormat  only for `sequence` (png, the default, or jpeg): a video is always drawn losslessly and encoded
 *   sequence     numbered pictures in `output`, element-<frame>.png (from the first frame, zero-padded to the last frame's
 *                digits, as Remotion names them). With the fork build: `render --sequence <output>`, straight PNGs. Without
 *                it (npm 0.2.0, which renders video only) or for jpeg: the frames go into a ProRes 4444 file beside them,
 *                which ffmpeg (kgFfmpeg) writes out as the pictures
 *   frames       [from, to], both rendered
 *   props        an object, a JSON string or a JSON file
 *   strict       fail on content Kinetograph can't draw, instead of leaving it out with a warning
 *   root         the studio (default: this one), for where Kinetograph is installed
 */
export function kgRender({ root = studioRoot(), entry = 'src/index.ts', composition, output, codec, crf, imageFormat, pixelFormat, sequence = false, frames, scale, props, concurrency, strict = false } = {}) {
  if (!output) throw new Error('kgRender: no output');
  const kg = kgCommand(root).map(shq);
  const r = range(frames);
  const args = [...kg, 'render', shq(entry)];
  if (composition) args.push('--comp', shq(composition));
  args.push(...propsArg(props));
  if (strict) args.push('--strict');
  if (r) args.push('--range', `${r.from}..=${r.to}`);
  if (scale !== undefined && scale !== null && Number(scale) !== 1) args.push('--scale', String(Number(scale)));
  // Remotion's "50%" form has no equivalent: Kinetograph's own default (half the cores, at most 4) is used then.
  if (Number.isInteger(Number(concurrency)) && Number(concurrency) > 0) args.push('--concurrency', String(Number(concurrency)));
  if (sequence && !(imageFormat === 'jpeg' || imageFormat === 'jpg') && kgHasSequence(root)) {
    args.push('--sequence', shq(output.replace(/\/+$/, '')));
    return [`mkdir -p ${shq(output)}`, args.join(' ')].join(' && ');
  }
  if (sequence) {
    const ext = imageFormat === 'jpeg' || imageFormat === 'jpg' ? 'jpeg' : 'png';
    const tmp = `${output.replace(/\/+$/, '')}/.kg-sequence.mov`;
    const pad = r ? Math.max(1, String(r.to).length) : 4;
    const ff = kgFfmpeg();
    // The ProRes file is BT.709, limited range (tagged so); ffmpeg's own RGB conversion would read it as BT.601 and shift
    // the colours (#f97316 came back #ed6b1b), so the matrix is named.
    args.push('-o', shq(tmp), '--codec', 'prores', '--prores-profile', '4444');
    return [`mkdir -p ${shq(output)}`, args.join(' '),
      `${shq(ff)} -v error -y -i ${shq(tmp)} -vf scale=in_color_matrix=bt709:in_range=tv -start_number ${r ? r.from : 0}${ext === 'jpeg' ? ' -q:v 2' : ''} ${shq(`${output.replace(/\/+$/, '')}/element-%0${pad}d.${ext}`)}`,
      `rm -f ${shq(tmp)}`].join(' && ');
  }
  args.push('-o', shq(output));
  const c = codec ? CODECS[codec] : null;
  if (codec && !c) throw new Error(`The renderer can't render codec "${codec}" (${Object.keys(CODECS).join(', ')})`);
  if (c) args.push('--codec', c);
  if (crf !== undefined && crf !== null && c !== 'prores' && c !== 'gif') args.push('--crf', String(Number(crf)));
  if (pixelFormat && c !== 'gif') args.push('--pixel-format', shq(pixelFormat));
  return args.join(' ');
}

/**
 * One frame to a PNG, as one shell command run in the project folder. Kinetograph's still has no --scale: a scaled
 * still is a one-frame sequence render. Stills are always PNG.
 */
export function kgStill({ root = studioRoot(), entry = 'src/index.ts', composition, output, frame = 0, scale, props, strict = false } = {}) {
  if (!output) throw new Error('kgStill: no output');
  if (scale !== undefined && scale !== null && Number(scale) !== 1) {
    const dir = `${output}.frames`;
    const f = Number(frame);
    return `${kgRender({ root, entry, composition, output: dir, sequence: true, frames: [f, f], scale, props, strict })} && mv ${shq(`${dir}/element-${String(f)}.png`)} ${shq(output)} && rm -rf ${shq(dir)}`;
  }
  return [...kgCommand(root).map(shq), 'still', shq(entry), String(Number(frame)), ...(composition ? ['--comp', shq(composition)] : []), ...propsArg(props), ...(strict ? ['--strict'] : []), '-o', shq(output)].join(' ');
}
