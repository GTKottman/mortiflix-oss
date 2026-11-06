// The Assets panel (owner, 2026-11-05): what a project has made, what each AI call was sent, and how far each New project
// setting reaches. Read-only. "Reaches" says what the code does today (svc/brief.mjs serviceBrief, quickframes, quickstills):
// the brief block goes to the Script and Brief calls and to full AI sessions, its visual part to Look, and to none of the
// one-call Voice, Music or Motion scene steps.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { projectPaths } from '../projects.mjs';
import { FIELDS, SECTIONS, normalizeBrief } from './briefschema.mjs';
import { loadProjectBrief } from './briefmap.mjs';
import { shownValue } from './briefsummary.mjs';
import { sentDir, sentList } from './sentlog.mjs';

const SKIP = new Set(['node_modules', '.git', '.cache', '.remotion']);
const KINDS = {
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']),
  audio: new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac']),
  video: new Set(['.mp4', '.webm', '.mov', '.mkv']),
  text: new Set(['.json', '.jsonl', '.md', '.txt', '.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.srt', '.vtt', '.csv', '.yml', '.yaml', '.log', '.py']),
};
const READ_MAX = 8 * 1024 * 1024;

const GROUPS = [['brief', 'Brief'], ['script', 'Script'], ['voice', 'Voice & music'], ['look', 'Look'], ['motion', 'Motion'], ['sound', 'Sound'], ['finish', 'Finish'], ['project', 'Project notes']];
const RULES = [
  [/^(input\/|research\/|design\/sources\/|design\/brief\.json$|feedback\/brief)/, 'brief'],
  [/^(script\/|script\.md$|feedback\/script)/, 'script'],
  [/^(voice\/|music\/|out\/voice\/|feedback\/(voice|music))/, 'voice'],
  [/^(out\/frames\/|design\/|feedback\/(style-frames|stills|look))/, 'look'],
  [/^(video\/|checks\/|out\/scenes|out\/preflight\/|feedback\/(animatic|motion|transitions))/, 'motion'],
  [/^sound\//, 'sound'],
  [/^out\//, 'finish'],
];
const groupOf = (rel) => RULES.find(([re]) => re.test(rel))?.[1] || 'project';
const kindOf = (name) => Object.keys(KINDS).find((k) => KINDS[k].has(extname(name).toLowerCase())) || 'other';

function walk(dir, top, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(path, top, out);
    else if (st.isFile()) out.push({ path, rel: relative(top, path).split(sep).join('/'), name, size: st.size, modified: st.mtime.toISOString(), kind: kindOf(name) });
  }
}

function reach(f) {
  const reaches = ['Script', 'Full AI sessions'];
  if (f.section === 'visual' || f.used_by.includes('look') || f.used_by.includes('stills')) reaches.push('Look');
  if (f.used_by.includes('voice')) reaches.push('Voice & music');
  const misses = ['Voice & music', 'Look', 'One-call Motion scenes'].filter((x) => !reaches.includes(x));
  return { reaches, misses, stored_only: !f.used_by.length };
}

function carried(root, id) {
  const doc = loadProjectBrief(root, id);
  if (!doc?.brief) return { idea: '', settings: [], left_to_studio: FIELDS.length };
  const { brief } = normalizeBrief(doc.brief);
  const later = brief.decide_later || {};
  const settings = [];
  for (const [sec, vals] of Object.entries(brief)) {
    const section = SECTIONS.find((s) => s.id === sec);
    if (!section) continue;
    for (const [k, val] of Object.entries(vals)) {
      const f = FIELDS.find((x) => x.id === `${sec}.${k}`);
      const value = shownValue(val);
      if (!f || !value || (sec === 'voice' && later[k])) continue;
      settings.push({ id: f.id, label: f.label, section: section.label, value, ...reach(f) });
    }
  }
  return { idea: String(brief.idea || ''), settings, left_to_studio: FIELDS.length - settings.length };
}

export function projectAssets(root, id) {
  const { work } = projectPaths(root, id);
  const files = [];
  if (existsSync(work)) walk(work, work, files);
  const groups = GROUPS.map(([key, label]) => ({ key, label, files: files.filter((f) => groupOf(f.rel) === key).sort((a, b) => a.rel.localeCompare(b.rel)) })).filter((g) => g.files.length);
  const dir = sentDir(root, id);
  return { groups, sent: sentList(root, id).map((s) => ({ ...s, path: join(dir, s.file) })), carried: carried(root, id) };
}

// A text file of this project, or one of its sent records; nothing else. The real path is checked, so a link can't lead out.
export function readProjectFile(root, id, path) {
  const bad = (m) => { const e = new Error(m); e.code = 'bad_request'; throw e; };
  if (!path || !existsSync(path)) bad('That file is gone.');
  const real = realpathSync(path);
  const inside = [projectPaths(root, id).work, sentDir(root, id)].some((d) => existsSync(d) && real.startsWith(realpathSync(d) + sep));
  if (!inside) bad('That file is not part of this project.');
  if (kindOf(real) !== 'text') bad('That file is not text.');
  const size = lstatSync(real).size;
  if (size > READ_MAX) bad('That file is too big to show here.');
  return { text: readFileSync(real, 'utf8'), size };
}
