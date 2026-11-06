// A new project's brief (plan 52): the brief maps into today's intake answers, is saved with the project, and is read by
// the later steps as a plain-words block (serviceBrief) and, for the look, by the frames and stills prompts.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths } from '../projects.mjs';
import { normalizeBrief, valueOf, FIELDS } from './briefschema.mjs';
import { briefText } from './briefsummary.mjs';
import { getDraft, listSources, moveSourcesToProject, DRAFT_ID } from './briefstore.mjs';

const bad = (m) => { const e = new Error(m); e.code = 'bad_request'; throw e; };

// -> { brief, answers (partial intake answers from the brief), draft }. Invalid brief = a plain error, no project.
export function readBrief(root, p, pipeline) {
  const raw = p?.brief ?? (p?.draft ? getDraft(root, p.draft)?.brief : null);
  if (raw == null) return { brief: null, answers: {} };
  if (p?.draft && !DRAFT_ID.test(String(p.draft))) bad('That draft id is not valid.');
  const { brief, errors } = normalizeBrief(raw);
  if (errors.length) bad(errors[0].message);
  const ids = new Set(pipeline.intake.map((q) => q.id));
  const choices = (id) => pipeline.intake.find((q) => q.id === id)?.choices || null;
  const a = {};
  const sources = p?.draft ? listSources(root, p.draft) : [];
  const aud = valueOf(brief, 'story.audience');
  if (ids.has('audience') && aud.value) a.audience = aud.value;
  const dur = valueOf(brief, 'delivery.duration').value;
  if (ids.has('length') && dur.mode === 'manual' && dur.seconds) a.length = `${dur.seconds} s`;
  const asp = valueOf(brief, 'delivery.aspects');
  if (ids.has('aspect') && asp.origin !== 'default' && asp.value[0] && (choices('aspect') || [asp.value[0]]).includes(asp.value[0])) a.aspect = asp.value[0];
  const url = sources.find((s) => s.url);
  if (ids.has('source_url') && url) a.source_url = url.url;
  return { brief, answers: a, draft: p?.draft || null };
}

// A project left unnamed is named from its idea, short and plain, never after the pipeline ("Mortiflix v3 video"):
// the first sentence, cut at its first comma, colon or dash when that still says something, at most 8 words.
const TITLE_WORDS = 8;
export function titleFromIdea(idea) {
  const text = String(idea || '').replace(/\s+/g, ' ').trim().replace(/^["'“‘]+/, '');
  const sentence = (/^[^.!?\n]*[?!]?/.exec(text)?.[0] || '').trim();
  const words = (s) => s.split(' ').filter(Boolean);
  let title = sentence;
  if (words(title).length > TITLE_WORDS) {
    const clause = sentence.split(/\s*[,:;—–]\s*|\s+-\s+/)[0];
    title = words(clause).length >= 3 ? clause : sentence;
  }
  const kept = words(title);
  title = kept.slice(0, TITLE_WORDS).join(' ').replace(/[\s,:;—–-]+$/, '');
  if (kept.length > TITLE_WORDS) title = title.replace(/[?!]$/, '');
  title = title.replace(/[.]+$/, '').replace(/["'”’]+$/, '');
  return title ? title[0].toUpperCase() + title.slice(1) : '';
}

// After the project exists: save the brief next to it and move the draft's sources in.
export function saveProjectBrief(root, id, { brief, draft }) {
  const pp = projectPaths(root, id);
  const sources = draft ? moveSourcesToProject(root, draft, pp.work) : [];
  mkdirSync(join(pp.work, 'design'), { recursive: true });
  const doc = { brief, sources, saved_at: new Date().toISOString() };
  writeFileSync(join(pp.state, 'brief.json'), JSON.stringify(doc, null, 1));
  writeFileSync(join(pp.work, 'design', 'brief.json'), JSON.stringify(doc, null, 1));
  return doc;
}

export function loadProjectBrief(root, id) {
  try { return JSON.parse(readFileSync(join(projectPaths(root, id).state, 'brief.json'), 'utf8')); } catch { return null; }
}

// The "production brief" block for the AI; '' when the project has none or nothing was specified.
export function briefBlock(root, id, { only = null } = {}) {
  const doc = loadProjectBrief(root, id);
  if (!doc?.brief) return '';
  const b = only ? Object.fromEntries(Object.entries(doc.brief).filter(([k]) => ['version', 'meta', 'decide_later', ...only].includes(k))) : doc.brief;
  const text = briefText(b, only ? [] : doc.sources || []);
  return text;
}

export const STORED_ONLY = FIELDS.filter((f) => !f.used_by.length).map((f) => f.id);
