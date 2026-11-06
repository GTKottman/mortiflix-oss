// kinetograph is the studio's renderer: the command lines it is given, and that nothing renders with Remotion any more.
// Flag names are kinetograph 0.2.0's own (packages/cli/src/commands/render.ts, export-options.ts, args.ts,
// commands/types.ts); its parser is strict, so any other flag would stop the render with INVALID_ARG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempStudio } from './helpers.mjs';
import { kgRender, kgStill, kgCommand, kgResolve, kgResetResolve, npxCacheCli, KINETOGRAPH_VERSION, kgStatus, kgHasSequence, kgPacks, kgSourceFile, nativePackage } from '../src/kinetograph.mjs';

const REPO = new URL('..', import.meta.url).pathname;

// Every option `kinetograph render` and `kinetograph still` take (project options --comp/--props/--offline and --json
// are added to both). `-o` is --output's short form.
const PROJECT = ['comp', 'props', 'offline', 'json'];
const RENDER_FLAGS = new Set([...PROJECT, 'output', 'o', 'range', 'encoder', 'draft', 'scale', 'codec', 'crf', 'video-bitrate', 'pixel-format', 'prores-profile', 'audio-codec', 'audio-bitrate', 'every-nth-frame', 'concurrency', 'strict', 'dev-react', 'sequence']);
const STILL_FLAGS = new Set([...PROJECT, 'output', 'o', 'strict', 'dev-react']);
const BOOLEAN = new Set(['offline', 'json', 'draft', 'strict', 'dev-react']);

// The words bash makes of one simple command string, exactly as the program would receive them. A chain (`a && b`) is
// split first, never run.
function words(cmd) {
  const r = spawnSync('bash', ['-c', `printf '%s\\0' ${cmd}`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent-home' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').slice(0, -1);
}

// The subcommand's positionals and flags, from the words after `render` / `still`.
function parse(cmd, sub) {
  const w = words(cmd);
  const at = w.indexOf(sub);
  assert.ok(at >= 0, `"${sub}" in ${JSON.stringify(w)}`);
  const head = w.slice(0, at).join(' ');
  const flags = {};
  const positionals = [];
  const rest = w.slice(at + 1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const m = /^--?([a-z][a-z-]*)(?:=(.*))?$/s.exec(a);
    if (!m) { positionals.push(a); continue; }
    const name = m[1] === 'o' ? 'output' : m[1];
    if (m[2] !== undefined) flags[name] = m[2];
    else if (BOOLEAN.has(name)) flags[name] = true;
    else flags[name] = rest[++i];
  }
  return { head, words: w, positionals, flags, raw: rest.filter((a) => a.startsWith('-')).map((a) => a.replace(/^--?/, '').split('=')[0]) };
}

test('kgRender: Remotion-style options become kinetograph render flags', () => {
  const cmd = kgRender({ entry: 'src/index.ts', composition: 'Main', output: '../out/final.mp4', codec: 'h264', crf: 18, pixelFormat: 'yuv420p', frames: [10, 40], scale: 0.5, props: { title: 'Bikes', n: 3 }, concurrency: 4 });
  assert.equal(typeof cmd, 'string');
  const p = parse(cmd, 'render');
  assert.match(p.head, /kinetograph/, 'the program is kinetograph');
  assert.deepEqual(p.positionals, ['src/index.ts'], 'the entry is the only positional: the composition is --comp, the output -o/--output');
  assert.equal(p.flags.comp, 'Main');
  assert.equal(p.flags.output, '../out/final.mp4');
  assert.equal(p.flags.codec, 'h264');
  assert.equal(Number(p.flags.crf), 18);
  assert.equal(p.flags['pixel-format'], 'yuv420p');
  // Remotion's --frames=10-40 is inclusive; kinetograph's inclusive range is 10..=40 (10..40 would stop at 39).
  assert.equal(p.flags.range, '10..=40');
  assert.equal(Number(p.flags.scale), 0.5);
  assert.equal(Number(p.flags.concurrency), 4);
  assert.deepEqual(JSON.parse(p.flags.props), { title: 'Bikes', n: 3 }, '--props is inline JSON, not a file');
  for (const f of p.raw) assert.ok(RENDER_FLAGS.has(f), `kinetograph render has no --${f}`);
});

test('kgRender: the animatic\'s call (as quickanimatic makes it) drops the Remotion-only image format', () => {
  const p = parse(kgRender({ entry: 'src/index.ts', composition: 'Main', output: '../out/animatic.mp4', codec: 'h264', crf: 20, imageFormat: 'png', pixelFormat: 'yuv420p', concurrency: 4 }), 'render');
  assert.deepEqual(p.positionals, ['src/index.ts']);
  assert.equal(p.flags.comp, 'Main');
  assert.equal(p.flags.output, '../out/animatic.mp4');
  assert.equal(p.flags.range, undefined, 'no frames asked: the whole composition');
  for (const f of p.raw) assert.ok(RENDER_FLAGS.has(f), `kinetograph render has no --${f}`);
  for (const gone of ['image-format', 'gl', 'log', 'frames', 'sequence']) assert.ok(!p.raw.includes(gone), `no --${gone}`);
});

test('kgRender: the entry defaults to src/index.ts and nothing undefined reaches the command line', () => {
  const cmd = kgRender({ composition: 'Cut01', output: 'out.mp4' });
  const p = parse(cmd, 'render');
  assert.deepEqual(p.positionals, ['src/index.ts']);
  assert.equal(p.flags.comp, 'Cut01');
  assert.doesNotMatch(cmd, /undefined|null|NaN|\[object Object\]/);
  for (const f of p.raw) assert.ok(RENDER_FLAGS.has(f), `kinetograph render has no --${f}`);
});

test('kgStill: `still <entry> <frame>`, the frame a positional that defaults to 0', () => {
  const p = parse(kgStill({ entry: 'src/index.ts', composition: 'SF01', output: '../out/frames/sf01.png', frame: 45, props: { look: 'flat' } }), 'still');
  assert.deepEqual(p.positionals, ['src/index.ts', '45']);
  assert.equal(p.flags.comp, 'SF01');
  assert.equal(p.flags.output, '../out/frames/sf01.png');
  assert.deepEqual(JSON.parse(p.flags.props), { look: 'flat' });
  for (const f of p.raw) assert.ok(STILL_FLAGS.has(f), `kinetograph still has no --${f}`);
  const d = parse(kgStill({ composition: 'Main', output: 'a.png' }), 'still');
  assert.deepEqual(d.positionals, ['src/index.ts', '0']);
  // `kinetograph still` has no --scale (only render does): a scaled still is a one-frame sequence render, then the
  // one picture moved to the output.
  const sc = kgStill({ composition: 'Main', output: 'a.png', frame: 7, scale: 0.5 });
  const steps = sc.split(' && ');
  assert.ok(!steps.some((x) => / still /.test(x)), 'no `still` with --scale');
  const r = parse(steps.find((x) => / render /.test(x)), 'render');
  assert.equal(Number(r.flags.scale), 0.5);
  assert.equal(r.flags.range, '7..=7');
  for (const f of r.raw) assert.ok(RENDER_FLAGS.has(f), `kinetograph render has no --${f}`);
  assert.deepEqual(words(steps.find((x) => x.startsWith('mv '))), ['mv', 'a.png.frames/element-7.png', 'a.png']);
});

// Run a body with MFX_KG_SEQUENCE forced ('1' fork build, '0' npm 0.2.0).
const withSeq = (v, fn) => { const o = process.env.MFX_KG_SEQUENCE; process.env.MFX_KG_SEQUENCE = v; try { return fn(); } finally { if (o === undefined) delete process.env.MFX_KG_SEQUENCE; else process.env.MFX_KG_SEQUENCE = o; } };

test('kgRender sequence with --sequence support: mkdir, then one render writing the PNGs, no ProRes, no ffmpeg', () => withSeq('1', () => {
  const steps = kgRender({ composition: 'Cut01', output: '../out/board/raw-01/', sequence: true, imageFormat: 'png', frames: [30, 66] }).split(' && ');
  assert.equal(steps.length, 2);
  assert.deepEqual(words(steps[0]), ['mkdir', '-p', '../out/board/raw-01/']);
  const r = parse(steps[1], 'render');
  assert.equal(r.flags.sequence, '../out/board/raw-01');
  assert.equal(r.flags.range, '30..=66');
  assert.ok(!r.raw.includes('output') && !r.raw.includes('codec'), 'no -o / --codec');
  for (const f of r.raw) assert.ok(RENDER_FLAGS.has(f), `kinetograph render has no --${f}`);
  // a scaled still takes the same route and still finds element-<frame>.png
  const sc = kgStill({ composition: 'Main', output: 'a.png', frame: 7, scale: 0.5 });
  assert.match(sc, /--sequence a\.png\.frames/);
  assert.deepEqual(words(sc.split(' && ').find((x) => x.startsWith('mv '))), ['mv', 'a.png.frames/element-7.png', 'a.png']);
}));

test('kgRender sequence falls back to ProRes + ffmpeg for jpeg, or when the CLI has no --sequence', () => {
  withSeq('1', () => assert.match(kgRender({ composition: 'C', output: 'o', sequence: true, imageFormat: 'jpeg', frames: [0, 3] }), /prores-profile 4444/));
  withSeq('0', () => assert.doesNotMatch(kgRender({ composition: 'C', output: 'o', sequence: true, frames: [0, 3] }), / --sequence /));
});

test('kgHasSequence asks `render --help` once per CLI and caches it', (t) => {
  const root = tempStudio(t);
  const cli = join(root, 'fake-cli.mjs');
  const log = join(root, 'calls.log');
  writeFileSync(cli, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, 'x'); console.log('Options: --sequence <string>  pictures');\n`);
  const old = process.env.MFX_KINETOGRAPH; process.env.MFX_KINETOGRAPH = cli; kgResetResolve();
  t.after(() => { if (old === undefined) delete process.env.MFX_KINETOGRAPH; else process.env.MFX_KINETOGRAPH = old; kgResetResolve(); });
  assert.equal(kgHasSequence(root), true);
  assert.equal(kgHasSequence(root), true);
  assert.equal(readFileSync(log, 'utf8'), 'x', 'asked once');
  writeFileSync(cli, `console.log('Options: --draft');\n`);
  kgResetResolve();
  assert.equal(kgHasSequence(root), false);
});

test('kgRender sequence (npm 0.2.0 fallback): a ProRes 4444 file, then ffmpeg (not the addon\'s encode-only one) writes element-<frame>.png from the first frame', () => withSeq('0', () => {
  const cmd = kgRender({ composition: 'Cut01', output: '../out/board/raw-01', sequence: true, imageFormat: 'png', frames: [30, 66] });
  const steps = cmd.split(' && ');
  assert.equal(steps.length, 4, 'mkdir, render, ffmpeg, rm');
  assert.deepEqual(words(steps[0]), ['mkdir', '-p', '../out/board/raw-01']);
  const r = parse(steps[1], 'render');
  assert.equal(r.flags.comp, 'Cut01');
  assert.equal(r.flags.range, '30..=66');
  assert.equal(r.flags.codec, 'prores');
  assert.equal(r.flags['prores-profile'], '4444');
  assert.equal(r.flags.output, '../out/board/raw-01/.kg-sequence.mov');
  for (const f of r.raw) assert.ok(RENDER_FLAGS.has(f), `kinetograph render has no --${f}`);
  for (const gone of ['sequence', 'image-format', 'json']) assert.ok(!r.raw.includes(gone), `no --${gone}`);
  const ff = words(steps[2]);
  assert.match(ff[0], /ffmpeg/);
  assert.doesNotMatch(ff[0], /@kinetographdev/, 'the addon\'s ffmpeg has no PNG encoder or ProRes decoder');
  assert.equal(ff[ff.indexOf('-i') + 1], '../out/board/raw-01/.kg-sequence.mov');
  assert.equal(ff[ff.indexOf('-start_number') + 1], '30');
  assert.equal(ff[ff.indexOf('-vf') + 1], 'scale=in_color_matrix=bt709:in_range=tv', 'BT.709 back to RGB, so colours match the stills');
  assert.equal(ff.at(-1), '../out/board/raw-01/element-%02d.png');
  assert.deepEqual(words(steps[3]), ['rm', '-f', '../out/board/raw-01/.kg-sequence.mov']);
}));

test('kgRender never passes --json (the queue reads the stderr progress line)', () => {
  for (const o of [{ output: 'a.mp4' }, { output: 'seq', sequence: true, frames: [0, 9] }]) assert.doesNotMatch(kgRender({ composition: 'Main', ...o }), /--json/);
  assert.doesNotMatch(kgStill({ composition: 'Main', output: 'a.png' }), /--json/);
});

test('kinetograph commands quote paths and props safely inside bash -c', () => {
  const output = "../out/it's a \"test\" $HOME `id`; rm -rf x/final.mp4";
  const props = { title: "it's \"quoted\" $HOME `id` ; echo pwned", list: ['a b', "c'd"], nested: { x: '\\n' } };
  const r = parse(kgRender({ entry: 'src/my entry.ts', composition: 'Main', output, props }), 'render');
  assert.deepEqual(r.positionals, ['src/my entry.ts']);
  assert.equal(r.flags.output, output);
  assert.deepEqual(JSON.parse(r.flags.props), props);
  assert.ok(!r.words.includes('pwned') && !r.words.includes('rm'), 'nothing in a value became its own word');
  const s = parse(kgStill({ entry: 'src/index.ts', composition: 'Main', output, frame: 3, props }), 'still');
  assert.equal(s.flags.output, output);
  assert.deepEqual(JSON.parse(s.flags.props), props);
});

test('kinetograph: the command and its status', (t) => {
  const root = tempStudio(t);
  const argv = kgCommand(root);
  assert.ok(Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string' && a.length > 0));
  assert.ok(argv.some((a) => /kinetograph/.test(a)), 'it runs kinetograph');
  assert.ok(!argv.some((a) => /remotion/i.test(a)));
  // kinetograph may or may not be installed on the test machine; either way it answers in the same shape.
  const st = kgStatus(root);
  assert.equal(typeof st.ok, 'boolean');
  assert.equal(typeof st.detail, 'string');
  if (st.ok) assert.match(String(st.version), /\d+\.\d+\.\d+/);
});

test('no render or still in src/ or pipelines/ runs Remotion any more', () => {
  const bad = [/\bnpx\s+remotion\b/, /\bremotion\s+(render|still)\b/, /\bnpx\s+@remotion\/cli\b/];
  // A line that says not to (e.g. "never `npx remotion render`") is allowed. The merger may narrow this if a doc
  // needs other wording.
  const allowed = /\b(never|not|no more|instead of|don't|do not|replaced?)\b/i;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const f = join(dir, name);
      const st = statSync(f);
      if (st.isDirectory()) { walk(f); continue; }
      if (!/\.(m?js|cjs|ts|tsx|json|md|sh|py|txt)$/.test(name) || st.size > 2_000_000) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (bad.some((re) => re.test(line)) && !allowed.test(line)) hits.push(`${f.slice(REPO.length)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
  };
  walk(join(REPO, 'src'));
  walk(join(REPO, 'pipelines'));
  assert.deepEqual(hits, [], `still rendering with Remotion:\n${hits.join('\n')}`);
});

test('sessions get the studio\'s kinetograph on their PATH, and the backends keep that PATH', async (t) => {
  const { mkdirSync } = await import('node:fs');
  const { sessionToolsEnv } = await import('../src/setup.mjs');
  const { kgBinDir } = await import('../src/kinetograph.mjs');
  const root = tempStudio(t);
  mkdirSync(kgBinDir(root), { recursive: true });
  const env = sessionToolsEnv(root);
  assert.ok(env.PATH.startsWith(kgBinDir(root)), env.PATH);
  // Both backends build PATH from the session's env, not from the service's own PATH (which has no kinetograph).
  for (const f of ['claude-code.mjs', 'anthropic-api.mjs']) {
    const src = readFileSync(join(REPO, 'src', 'backends', f), 'utf8');
    assert.match(src, /withPath\(\{\s*\.\.\.process\.env,\s*\.\.\.env\b/, f);
  }
  // withPath (platform.mjs): the repo's bin/ first, then the session's PATH (Path on Windows, `;` there).
  const { withPath } = await import('../src/platform.mjs');
  const merged = withPath({ ...process.env, ...env }, join(REPO, 'bin'));
  assert.ok(merged.PATH.startsWith(`${join(REPO, 'bin')}:${kgBinDir(root)}`), merged.PATH);
});

// The owner's fork build, packed by the fork's scripts/pack-local.mjs: setup installs from its tarballs when they are
// here, and kgStatus says which build is installed.
function fakePacks(dir, commit = 'abc1234def') {
  mkdirSync(dir, { recursive: true });
  const native = nativePackage();
  const packages = [['kinetograph', 'kinetograph-0.2.0.tgz'], ['@kinetographdev/core', 'kinetographdev-core-0.2.0.tgz'], [native, `${native.replace('@', '').replace('/', '-')}-0.2.0.tgz`]]
    .map(([name, file]) => { writeFileSync(join(dir, file), 'x'); return { name, version: '0.2.0', file }; });
  writeFileSync(join(dir, 'BUILD.json'), JSON.stringify({ commit, branch: 'mortiflix', dirty: false, platform: native, packages }));
}

function fakeInstall(root, from) {
  const pkg = join(root, 'tools', 'kinetograph', 'node_modules', 'kinetograph');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'cli.js'), '');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'kinetograph', version: '0.2.0' }));
  mkdirSync(join(root, 'tools', 'kinetograph', 'node_modules', nativePackage()), { recursive: true });
  writeFileSync(join(root, 'tools', 'kinetograph', 'node_modules', nativePackage(), 'package.json'), '{}');
  if (from) writeFileSync(kgSourceFile(root), JSON.stringify(from));
}

test('kgPacks: the fork build\'s tarballs in tools/downloads/kinetograph, MFX_KINETOGRAPH_PACKS or a fork folder', (t) => {
  if (!nativePackage()) return t.skip('no Kinetograph platform here');
  const saved = process.env.MFX_KINETOGRAPH_PACKS;
  delete process.env.MFX_KINETOGRAPH_PACKS;
  t.after(() => { if (saved === undefined) delete process.env.MFX_KINETOGRAPH_PACKS; else process.env.MFX_KINETOGRAPH_PACKS = saved; });
  const root = tempStudio(t);
  assert.equal(kgPacks(root), null, 'none: npm');
  const dl = join(root, 'tools', 'downloads', 'kinetograph');
  fakePacks(dl);
  const p = kgPacks(root);
  assert.equal(p.dir, dl);
  assert.equal(p.build.commit, 'abc1234def');
  assert.equal(p.files.kinetograph, join(dl, 'kinetograph-0.2.0.tgz'));
  assert.ok(p.files[nativePackage()], 'this computer\'s addon');
  // a fork checkout (its packs/ folder) named by the environment wins over the downloads folder
  const fork = mkdtempSync(join(tmpdir(), 'mfx-fork-'));
  t.after(() => rmSync(fork, { recursive: true, force: true }));
  fakePacks(join(fork, 'packs'), 'f0f0f0f0');
  process.env.MFX_KINETOGRAPH_PACKS = fork;
  assert.equal(kgPacks(root).build.commit, 'f0f0f0f0');
  // without this computer's addon the tarballs are no use
  rmSync(join(fork, 'packs', JSON.parse(readFileSync(join(fork, 'packs', 'BUILD.json'), 'utf8')).packages[2].file));
  assert.equal(kgPacks(root).dir, dl);
});

test('kgStatus: names the fork build installed, and asks for a reinstall when the packed build differs', (t) => {
  if (!nativePackage()) return t.skip('no Kinetograph platform here');
  const saved = { packs: process.env.MFX_KINETOGRAPH_PACKS, kg: process.env.MFX_KINETOGRAPH };
  delete process.env.MFX_KINETOGRAPH_PACKS;
  delete process.env.MFX_KINETOGRAPH;
  t.after(() => { for (const [k, v] of [['MFX_KINETOGRAPH_PACKS', saved.packs], ['MFX_KINETOGRAPH', saved.kg]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const root = tempStudio(t);
  fakeInstall(root);
  let st = kgStatus(root);
  assert.equal(st.ok, true, st.detail);
  assert.equal(st.source, 'npm');
  // a fork build arrives: the npm install is out of date
  const dl = join(root, 'tools', 'downloads', 'kinetograph');
  fakePacks(dl, 'abc1234def');
  st = kgStatus(root);
  assert.equal(st.ok, false);
  assert.match(st.detail, /newer build .*reinstall/);
  // installed from it
  writeFileSync(kgSourceFile(root), JSON.stringify({ source: 'fork', commit: 'abc1234def', branch: 'mortiflix', packs: dl }));
  st = kgStatus(root);
  assert.equal(st.ok, true, st.detail);
  assert.equal(st.source, 'fork');
  assert.match(st.detail, /build mortiflix abc1234d/);
  // a newer pack
  fakePacks(dl, '9999999999');
  st = kgStatus(root);
  assert.equal(st.ok, false);
  assert.match(st.detail, /99999999, reinstall/);
});

test('kinetograph: npx cache copy of the pinned version is found, another version is not; resolve is memoized', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'kgres-'));
  t.after(() => { rmSync(tmp, { recursive: true, force: true }); kgResetResolve(); });
  const mk = (h, v) => {
    const nm = join(tmp, '_npx', h, 'node_modules');
    mkdirSync(join(nm, 'kinetograph', 'dist'), { recursive: true });
    writeFileSync(join(nm, 'kinetograph', 'dist', 'cli.js'), '');
    writeFileSync(join(nm, 'kinetograph', 'package.json'), JSON.stringify({ version: v }));
    mkdirSync(join(nm, nativePackage()), { recursive: true });
    writeFileSync(join(nm, nativePackage(), 'package.json'), '{}');
    return join(nm, 'kinetograph', 'dist', 'cli.js');
  };
  assert.equal(npxCacheCli(KINETOGRAPH_VERSION, { cacheDir: tmp }), null);
  mk('aaa', '9.9.9');
  assert.equal(npxCacheCli(KINETOGRAPH_VERSION, { cacheDir: tmp }), null, 'wrong version ignored');
  const good = mk('bbb', KINETOGRAPH_VERSION);
  assert.equal(npxCacheCli(KINETOGRAPH_VERSION, { cacheDir: tmp }), good);
  const root = tempStudio(t);
  kgResetResolve();
  const a = kgResolve(root, { warn: () => {} });
  assert.equal(kgResolve(root), a, 'same object the second time');
  assert.ok(['install', 'npx-cache', 'npx'].includes(a.source));
});
