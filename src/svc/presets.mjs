// Presets for the New project window and the preset creator (doc 31). A preset is a pipeline: the built-in ones and
// the studio's own (pipelines/<slug>/ in the studio). Saving never changes a built-in preset: it makes your copy.
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { listPipelines, findPipeline, savePreset, loadPipeline, sharedSkillDir } from '../pipelines.mjs';
import { paths, UserError } from '../studio.mjs';
import { safeName } from '../projects.mjs';
import { stageOf, STAGES } from './stages.mjs';
import { cleanTheme } from './theme.mjs';

// Steps that always run, whatever the preset says (doc 31 page 6: Brief, Script and the final).
const ALWAYS = ['brief', 'script'];
const PICTURE = ['.jpg', '.jpeg', '.png', '.webp', '.svg'];

const choiceOf = (p, id) => p.intake.find((q) => q.id === id)?.default ?? null;

export function presetSummary(p) {
  if (p.error) return { slug: p.slug, name: p.slug, source: p.source, error: p.error };
  return {
    slug: p.slug,
    name: p.name,
    description: p.description,
    source: p.source,
    makes: p.makes,
    based_on: p.based_on || null,
    length: choiceOf(p, 'length'),
    aspect: choiceOf(p, 'aspect'),
    voice: choiceOf(p, 'voice'),
    music: choiceOf(p, 'music'),
    // The idea box is the preset's first required long answer (today's ideaOf in web/app.js).
    idea_field: (p.intake.find((q) => q.type === 'long' && q.required) || p.intake.find((q) => q.type === 'long'))?.id || null,
    stages: [...new Set(p.steps.filter((s) => !s.off).map((s) => STAGES[stageOf(s)]))],
    steps: p.steps.map((s) => ({ key: s.key, name: s.name, review: s.review, describe: s.describe, stage: STAGES[stageOf(s)], off: Boolean(s.off),
      waits: s.review !== 'internal' && !s.canvas, always: ALWAYS.includes(s.key) || s.delivers })),
  };
}

export function listPresets(root) {
  const all = listPipelines(root);
  const out = { built_in: [], yours: [] };
  for (const p of all) (p.source === 'built-in' ? out.built_in : out.yours).push(presetSummary(p));
  return out;
}

// Everything the creator's pages show for one preset.
export function getPreset(root, slug) {
  const p = findPipeline(root, slug);
  const skills = (p.shared_skills || []).map((name) => {
    const dir = sharedSkillDir(p.dir, name);
    const md = dir ? readFileSync(join(dir, 'SKILL.md'), 'utf8') : '';
    const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
    return { name, description: desc.slice(0, 300), shared: true };
  });
  const own = existsSync(join(p.dir, 'skills')) ? readdirSync(join(p.dir, 'skills')).filter((n) => existsSync(join(p.dir, 'skills', n, 'SKILL.md'))).map((name) => ({ name, shared: false })) : [];
  return { ...presetSummary(p), intake: p.intake, skills: [...skills, ...own], look: p.look || null, voice_preset: p.voice || null, music_theme: p.music_theme || null, editable: p.source !== 'built-in' };
}

// Save the whole preset (doc 31): defaults, steps on/off and waits, skills, look (words, pictures, how many frames),
// voice (name, delivery) and music theme. `from`: the preset it starts from (Start from / ✎).
export function savePresetFull(root, params = {}) {
  const from = String(params.from || params.slug || '');
  if (!from) throw new UserError('presets.save needs "from": the preset it starts from');
  const src = findPipeline(root, from);
  // Everything that can be refused is checked before anything is written.
  if (params.steps && typeof params.steps === 'object') {
    for (const s of src.steps) if (params.steps[s.key]?.on === false && (ALWAYS.includes(s.key) || s.delivers || s === src.steps.at(-1))) throw new UserError(`${s.name || s.key} always runs`);
  }
  const folders = (Array.isArray(params.skill_folders) ? params.skill_folders.slice(0, 20) : []).map((f) => {
    const real = realDir(f);
    if (!existsSync(join(real, 'SKILL.md'))) throw new UserError(`${basename(real)}: that folder has no SKILL.md`);
    return real;
  });
  const pictures = (Array.isArray(params.look?.pictures) ? params.look.pictures.slice(0, 24) : []).map((pic) => {
    if (typeof pic === 'string' && /^look\/[^/\\]+$/.test(pic) && existsSync(join(src.dir, pic))) return { keep: pic, from: join(src.dir, pic) };
    const real = realFile(pic);
    if (!PICTURE.includes(extname(real).toLowerCase())) throw new UserError('Only pictures (JPG, PNG, WebP, SVG)');
    return { from: real };
  });
  const { slug, name } = savePreset(root, from, { name: params.name, description: params.description, defaults: params.defaults || {}, replace: Boolean(params.replace) });
  const dir = join(paths(root).pipelines, slug);
  const file = join(dir, 'pipeline.json');
  const def = JSON.parse(readFileSync(file, 'utf8'));
  // Steps: { key: { on, waits } }.
  if (params.steps && typeof params.steps === 'object') {
    for (const s of def.steps) {
      const want = params.steps[s.key];
      if (!want || typeof want !== 'object') continue;
      if (want.on === false) s.off = true;
      else delete s.off;
      // "Waits for you": a reviewed step waits; off it goes ahead like a canvas step (the AI runs ahead).
      if (want.waits === false && s.review !== 'internal' && !s.canvas && !s.delivers) s.review = 'internal';
    }
  }
  // Skills: the shared ones kept (a skill a running step needs can't be dropped: the UI says which), plus folders
  // with a SKILL.md copied into the preset.
  if (Array.isArray(params.skills)) def.shared_skills = (def.shared_skills || []).filter((n) => params.skills.includes(n));
  for (const real of folders) {
    const nameOf = safeName(basename(real)).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48) || 'skill';
    cpSync(real, join(dir, 'skills', nameOf), { recursive: true, dereference: true });
  }
  if (params.look && typeof params.look === 'object') {
    const look = { words: String(params.look.words || '').slice(0, 4000), frames: [3, 4, 5].includes(params.look.frames) ? params.look.frames : 3, pictures: [] };
    mkdirSync(join(dir, 'look'), { recursive: true });
    for (const pic of pictures) {
      const dest = pic.keep || join('look', safeName(basename(pic.from)));
      if (!existsSync(join(dir, dest))) cpSync(pic.from, join(dir, dest));
      look.pictures.push(dest.split('\\').join('/'));
    }
    def.look = look;
  }
  if (params.voice && typeof params.voice === 'object') def.voice = { name: params.voice.name ? String(params.voice.name).slice(0, 120) : null, delivery: String(params.voice.delivery || '').slice(0, 500) };
  if (params.music_theme !== undefined) { if (params.music_theme) def.music_theme = cleanTheme(params.music_theme, { forPreset: true }); else delete def.music_theme; }
  writeFileSync(file, JSON.stringify(def, null, 2) + '\n');
  try { loadPipeline(dir); } catch (e) { rmSync(dir, { recursive: true, force: true }); throw new UserError(`that preset isn't valid: ${e.message}`); }
  return { slug, name, preset: getPreset(root, slug) };
}

export function deletePreset(root, slug) {
  const p = findPipeline(root, slug);
  if (p.source === 'built-in') throw new UserError(`${p.name} is built in: it can't be deleted`);
  rmSync(p.dir, { recursive: true, force: true });
  return { deleted: slug };
}

function realFile(f) {
  if (typeof f !== 'string' || !f) throw new UserError('a file path is needed');
  if (!existsSync(f)) throw new UserError(`no file ${basename(f)}`);
  const real = realpathSync(f);
  if (!statSync(real).isFile()) throw new UserError(`${basename(f)} isn't a file`);
  return real;
}

function realDir(f) {
  if (typeof f !== 'string' || !f || !existsSync(f)) throw new UserError('no such folder');
  const real = realpathSync(f);
  if (!statSync(real).isDirectory()) throw new UserError(`${basename(f)} isn't a folder`);
  return real;
}
