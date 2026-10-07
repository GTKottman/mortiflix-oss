#!/usr/bin/env node
// The transition board's tool, over the remotion-transitions library ($MFX_TRANSITIONS).
//
//   node board.mjs list [--function energy] [--family 04-cover]   the catalog, compact, to choose from
//   node board.mjs use <id> [<id>...]                             copy src/core + those transitions into video/src/transitions/
//   node board.mjs posters [board.json]                           each chosen transition's preview poster → transitions/posters/
//   node board.mjs check [transitions/board.json]                 the board's rules (must pass before submitting)
//   node board.mjs blank <image>... [--a A.png --b B.png]          whether a frame blanks the screen (flood, flash, emptied)
//   node board.mjs panels [transitions/board.json]                one review image per cut: A → in-betweens → B → the library's poster
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const LIB = process.env.MFX_TRANSITIONS;
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name) => { const i = args.indexOf(`--${name}`); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const die = (m) => { console.error(`✖ ${m}`); process.exit(1); };
if (!LIB || !existsSync(join(LIB, 'catalog.json'))) die('The transitions library isn\'t installed in this studio ($MFX_TRANSITIONS). `mfx needs-you "Run mortiflix setup transitions, then resume."`');
const catalog = JSON.parse(readFileSync(join(LIB, 'catalog.json'), 'utf8'));
const byId = new Map(catalog.transitions.map((t) => [t.id, t]));
const media = (url) => String(url || '').replace('<mediaBase>', catalog.mediaBase);

if (cmd === 'list') {
  const fn = opt('function'); const fam = opt('family');
  for (const t of catalog.transitions) {
    if (fn && !t.facets.function.includes(fn)) continue;
    if (fam && t.family !== fam) continue;
    const params = t.params.map((p) => p.name).join(', ');
    console.log(`${t.id.padEnd(24)} ${t.family}/${t.subfamily}  ${t.facets.structure}, ${t.facets.origin}, ${t.facets.function.join('+')}  ${t.duration.min}-${t.duration.max}f (${t.duration.default})${t.requires.length ? `  needs ${t.requires.join(',')}` : ''}`);
    console.log(`  ${t.summary}${params ? `  [${params}]` : ''}`);
  }
  console.log(`\n${catalog.transitions.length} transitions. Read TAXONOMY.md in ${LIB} for how they work and when each family fits.`);
} else if (cmd === 'use') {
  if (!args.length) die('use <id> [<id>...]');
  const dest = join('video', 'src', 'transitions');
  mkdirSync(dest, { recursive: true });
  rmSync(join(dest, 'core'), { recursive: true, force: true });
  cpSync(join(LIB, 'src', 'core'), join(dest, 'core'), { recursive: true });
  for (const id of args) {
    const t = byId.get(id);
    if (!t) die(`no transition "${id}" in the library (node board.mjs list)`);
    const to = join(dest, id);
    rmSync(to, { recursive: true, force: true });
    cpSync(join(LIB, t.path), to, { recursive: true });
    // The library imports its core as ../../../../src/core from every file: point them at the copy next door.
    for (const f of readdirSync(to, { recursive: true }).map(String).filter((f) => /\.(tsx?|mjs|js)$/.test(f))) {
      const file = join(to, f);
      const depth = f.split(/[\\/]/).length - 1;
      const up = '../'.repeat(depth + 1);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/(['"])(?:\.\.\/)+src\/core(\/[^'"]*)?\1/g, (_, q, rest = '') => `${q}${up}core${rest}${q}`));
    }
    console.log(`✔ ${id} → ${to}${t.requires.length ? ` (needs ${t.requires.join(', ')}: render with --gl=angle, or --gl=swangle without a GPU)` : ''}`);
  }
  console.log(`  core → ${join(dest, 'core')}. Use: <TransitionSeries.Transition presentation={toPresentation(t, params)} timing={linearTiming({ durationInFrames })} />`);
} else if (cmd === 'posters') {
  const board = JSON.parse(readFileSync(args[0] || 'transitions/board.json', 'utf8'));
  mkdirSync('transitions/posters', { recursive: true });
  const ids = new Set(board.cuts.flatMap((c) => (typeof c.transition === 'string' ? [c.transition] : c.transition?.inspired_by || [])));
  for (const id of ids) {
    const t = byId.get(id);
    if (!t?.media?.poster) { console.log(`· ${id}: no poster`); continue; }
    const out = join('transitions', 'posters', `${id}.jpg`);
    const r = spawnSync('curl', ['-sfL', '-o', out, media(t.media.poster)]);
    console.log(r.status === 0 ? `✔ ${out}` : `· ${id}: the poster isn't published yet`);
  }
} else if (cmd === 'check') {
  const file = args[0] || 'transitions/board.json';
  if (!existsSync(file)) die(`no ${file} (SKILL.md step 3)`);
  const board = JSON.parse(readFileSync(file, 'utf8'));
  const errors = []; const warnings = [];
  const cuts = board.cuts || [];
  if (!cuts.length) errors.push('No cuts: one entry for every change from one scene to the next.');
  const families = new Map();
  cuts.forEach((c, i) => {
    const at = `Cut ${i + 1} (${c.from} → ${c.to})`;
    if (i > 0 && cuts[i - 1].to !== c.from) errors.push(`${at} doesn't start where cut ${i} ended ("${cuts[i - 1].to}"): the board runs through the scenes in order.`);
    if (String(c.carrier || '').trim().length < 6) errors.push(`${at}: name the carrier, the object or element that makes the cut happen (a shape, a line, a colour, a camera move, a sound).`);
    if (String(c.why || '').trim().length < 20) errors.push(`${at}: say why, in a sentence: what the cut means in the story.`);
    let t = null;
    if (typeof c.transition === 'string') {
      t = byId.get(c.transition);
      if (!t) errors.push(`${at}: "${c.transition}" isn't in the library (node board.mjs list), or mark it new: {"new": "name", "inspired_by": ["id", ...]}.`);
    } else if (c.transition?.new) {
      const insp = c.transition.inspired_by || [];
      if (!insp.length || insp.some((id) => !byId.has(id))) errors.push(`${at}: a new transition names the library transitions that inspired it ("inspired_by": real ids).`);
      if (!existsSync(join('video', 'src', 'transitions', c.transition.new, 'index.tsx'))) errors.push(`${at}: the new transition "${c.transition.new}" needs its code in video/src/transitions/${c.transition.new}/index.tsx (library format, built on core/).`);
      t = byId.get(insp[0]);
    } else errors.push(`${at}: "transition" is a library id, or {"new": "name", "inspired_by": [...]}.`);
    if (t) {
      families.set(t.family, (families.get(t.family) || 0) + 1);
      if (typeof c.transition === 'string') {
        if (!(c.frames >= t.duration.min && c.frames <= t.duration.max)) errors.push(`${at}: ${c.frames} frames is outside ${t.id}'s range (${t.duration.min}-${t.duration.max}).`);
        if (t.params.some((p) => p.name === 'color') && !c.params?.color) warnings.push(`${at}: ${t.id} takes "color", the incoming scene's background colour: set it.`);
      }
    }
    if (!Number.isFinite(c.frames) || c.frames < 0) errors.push(`${at}: "frames", the transition's length in frames.`);
    if (!String(c.lands_on || '').trim()) errors.push(`${at}: "lands_on", the word or beat the cut lands on.`);
    for (const k of ['a', 'b']) if (!c[k] || !existsSync(c[k])) errors.push(`${at}: "${k}" must be the ${k === 'a' ? 'outgoing' : 'incoming'} style frame's image (missing ${c[k] || 'path'}).`);
    // The owner's rule: a transition never blanks the screen. Every frame across it still shows the scenes' own elements:
    // no frame of one solid colour, no blown-out white. Checked on the strip (every 10% of the transition) or the mids.
    const frames = [...(c.strip || []), ...(c.strip ? [] : c.mids || [])];
    if (!frames.length) errors.push(`${at}: render "strip", stills every 10% of the transition (SKILL.md step 5), so the check can see every moment of it.`);
    for (const f of frames) {
      if (!existsSync(f)) { errors.push(`${at}: missing ${f}`); continue; }
      const blank = blankness(f, c.a, c.b);
      if (blank) errors.push(`${at}: ${f} ${blank}. A transition never fills the screen with a colour or a flash: carry it with the elements on screen.`);
    }
  });
  const top = [...families.values()].sort((x, y) => y - x)[0] || 0;
  if (cuts.length >= 5 && top / cuts.length > 0.7) warnings.push('Most cuts come from one family: vary them by what each cut means (TAXONOMY.md), keeping a coherent vocabulary.');
  if (families.size > 5) warnings.push(`${families.size} families in one video: pick a smaller vocabulary (2-4) and save the big moves for section breaks.`);
  for (const w of warnings) console.log(`! ${w}`);
  if (errors.length) { console.log(`✖ ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n  ${errors.join('\n  ')}`); process.exit(1); }
  console.log(`✔ ${cuts.length} cuts, each carried by something and chosen for a reason; families: ${[...families.keys()].join(', ')}`);
} else if (cmd === 'blank') {
  // node board.mjs blank <image>...: what the check sees in a frame
  const a = opt('a'); const b = opt('b');   // the scenes it joins: --a sf01.png --b sf02.png
  for (const f of args) console.log(`${f}: ${blankness(f, a, b) || 'shows the scene'}`);
} else if (cmd === 'panels') {
  const board = JSON.parse(readFileSync(args[0] || 'transitions/board.json', 'utf8'));
  mkdirSync('out/board', { recursive: true });
  for (const [i, c] of board.cuts.entries()) {
    const tiles = [c.a, ...(c.mids || []), c.b];
    const posterId = typeof c.transition === 'string' ? c.transition : c.transition?.inspired_by?.[0];
    const poster = posterId && existsSync(join('transitions', 'posters', `${posterId}.jpg`)) ? join('transitions', 'posters', `${posterId}.jpg`) : null;
    if (poster) tiles.push(poster);
    for (const f of tiles) if (!existsSync(f)) die(`cut ${i + 1}: missing ${f} (render the in-betweens first: SKILL.md step 5)`);
    const out = join('out', 'board', `cut-${String(i + 1).padStart(2, '0')}.png`);
    // One row: the outgoing frame, the real in-betweens, the incoming frame, then the library's poster, dimmed, as the reference.
    const inputs = tiles.flatMap((f) => ['-i', f]);
    const scaled = tiles.map((_, k) => `[${k}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x0B0913${poster && k === tiles.length - 1 ? ',eq=brightness=-0.12:saturation=0.7' : ''},pad=652:360:0:0:color=0x000000[t${k}]`).join(';');
    const graph = `${scaled};${tiles.map((_, k) => `[t${k}]`).join('')}hstack=inputs=${tiles.length}`;
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-frames:v', '1', out], { encoding: 'utf8' });
    if (r.status !== 0) die(`ffmpeg: ${r.stderr}`);
    console.log(`✔ ${out}  ${c.from} → ${c.to}: ${typeof c.transition === 'string' ? c.transition : `new "${c.transition.new}"`} (${c.frames}f), carried by ${c.carrier}`);
  }
} else die('usage: board.mjs list|use|posters|check|panels (see SKILL.md)');

// Does a transition frame blank the screen? Judged against the two scenes it joins (64x36 samples):
//   blown out:  most of the frame near white
//   flooded:    most of the frame one colour that is neither scene's own background
//   emptied:    far less detail than either scene (the elements are gone: a dip to a plain colour)
function sample(file) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', 'scale=64:36:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const px = [];
  for (let i = 0; i + 2 < r.stdout.length; i += 3) px.push([r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]]);
  const median = [0, 1, 2].map((k) => px.map((p) => p[k]).sort((a, b) => a - b)[px.length >> 1]);
  const luma = px.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
  let detail = 0;
  for (let y = 0; y < 36; y++) for (let x = 0; x < 63; x++) detail += Math.abs(luma[y * 64 + x + 1] - luma[y * 64 + x]);
  for (let y = 0; y < 35; y++) for (let x = 0; x < 64; x++) detail += Math.abs(luma[(y + 1) * 64 + x] - luma[y * 64 + x]);
  return { px, median, detail: detail / (64 * 36), white: px.filter((p) => p[0] > 225 && p[1] > 215 && p[2] > 215).length / px.length };
}
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

function blankness(file, a = null, b = null) {
  const f = sample(file);
  if (!f) return null;
  const ends = [a, b].filter(Boolean).map(sample).filter(Boolean);
  const whiteBase = ends.length ? Math.max(...ends.map((e) => e.white)) : 0;
  if (f.white > 0.5 && f.white > whiteBase + 0.3) return `is blown out to white (${Math.round(f.white * 100)}% of the frame)`;
  const cover = f.px.filter((p) => dist(p, f.median) < 30).length / f.px.length;
  const foreign = ends.length ? ends.every((e) => dist(f.median, e.median) > 40) : true;
  if (cover > 0.6 && foreign) return `floods with one colour (${Math.round(cover * 100)}% of the frame is rgb(${f.median.join(', ')}), neither scene's own)`;
  if (ends.length && f.detail < 0.3 * Math.min(...ends.map((e) => e.detail))) return 'has lost the scenes\' elements (almost no detail left)';
  return null;
}
