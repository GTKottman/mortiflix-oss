// The script in one quick call. A full session spent fourteen steps on it (open the start files, write, fix with sed,
// split into beats, submit, tick the checklist), each step re-reading everything before it: ~650k tokens for a page
// of words. Here the studio hands one lean Claude Code call everything the script needs (the brief and its answers,
// the owner's chat, the pipeline's script rules, the last version and its notes) and gets the beats back as JSON
// (web search allowed, for the facts); the studio writes script.md and script/beats.json, counts the length itself,
// and submits. Anything it can't do honestly (an owner's own script in input/, a check it can't report, a length
// that won't fit) goes to a normal session, as before.
import { runAs } from './models.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, writeJson } from './studio.mjs';
import { loadProject, projectPaths, projectPipeline } from './projects.mjs';
import { stepView, stepChecks, submit, submissions } from './gates.mjs';
import { chatHistory } from './svc/chat.mjs';
import { serviceBrief } from './svc/brief.mjs';
import { listAssets } from './svc/assets.mjs';
import { speechPace } from './svc/pace.mjs';
import { narratorVoice } from './svc/voicecast.mjs';

export const WORDS_PER_MINUTE = 120; // only when no voice has been measured yet: scriptPace() is the real one
// Words a minute this project's narrator really speaks (pauses included), from the takes the studio made (svc/pace.mjs).
export function scriptPace(root, id) {
  try { return speechPace(root, { voiceId: narratorVoice(root, id).voice_id }).wpm; } catch { return WORDS_PER_MINUTE; }
}
const QUICK_CHECKS = ['spelling-and-facts', 'script-fits-length'];

// The script step, when it's the only work a session would do now and the quick call can do it; otherwise null.
export function quickScriptStep(root, id, config) {
  if (config.quickScript === false) return null;
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const step = pipeline.steps.find((s) => s.key === 'script');
  if (!step || step.review !== 'document') return null;
  const runnable = stepView(project, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  if (runnable.length !== 1 || runnable[0].key !== 'script') return null;
  if (project.mfx && Object.keys(project.mfx).some((k) => k.endsWith('_wanted'))) return null;
  // The owner's own script is tidied by a session (it's spoken verbatim).
  const input = join(projectPaths(root, id).work, 'input');
  if (existsSync(input) && readdirSync(input).length) return null;
  if (stepChecks(root, id, 'script').some((c) => !QUICK_CHECKS.includes(c.id))) return null;
  return runnable[0];
}

// "60 s", "90 seconds", "2 min", "1:30", "20-30 min" (the upper end) → seconds; null when it says no length.
export function lengthSeconds(text) {
  const s = String(text || '').toLowerCase();
  let m = /(\d+):(\d{2})/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(s\b|sec|seconds?|m\b|min|minutes?)/.exec(s);
  if (!m) return null;
  const n = Number(m[2] || m[1]);
  return /^m/.test(m[3]) ? n * 60 : n;
}

export const countWords = (text) => (String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).length;

const SCHEMA = {
  type: 'object',
  required: ['title', 'intro', 'beats', 'note', 'facts_note'],
  properties: {
    title: { type: 'string', description: 'the script heading, e.g. "The Golden Braid"' },
    intro: { type: 'string', description: 'two or three lines under the heading: length, voice, tone, pronunciations' },
    beats: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'words', 'visual'],
        properties: {
          name: { type: 'string', description: 'a short title, 2-4 words' },
          words: { type: 'string', description: 'exactly what the narrator says, nothing else' },
          visual: { type: 'string', description: 'one line: what is on screen' },
        },
      },
    },
    note: { type: 'string', description: 'for the owner: what this version is, the flow, and what to look at' },
    facts_note: { type: 'string', description: 'every name, date and number checked, and against what' },
    pin_changes: {
      type: 'array',
      items: { type: 'object', required: ['note', 'change', 'status'], properties: { note: { type: 'integer' }, change: { type: 'string' }, status: { type: 'string', enum: ['done', 'partly', 'not_done'] } } },
    },
  },
};

export function scriptPrompt(root, id, view, { targetSec, tooLong = null } = {}) {
  const project = loadProject(root, id);
  const pp = projectPaths(root, id);
  const subs = submissions(root, id);
  const brief = subs.filter((s) => s.step === 'brief').at(-1);
  const pipelineMd = existsSync(join(pp.work, 'pipeline', 'PIPELINE.md')) ? readFileSync(join(pp.work, 'pipeline', 'PIPELINE.md'), 'utf8') : '';
  const checks = stepChecks(root, id, 'script');
  const since = brief?.submitted_at || '';
  const chat = chatHistory(root, id, { limit: 500 }).filter((r) => ['user', 'action'].includes(r.role) && r.at >= since && !r.edit).slice(-40);
  const last = subs.filter((s) => s.step === 'script').at(-1);
  const parts = [
    `You write the script for "${project.title}", a ${projectPipeline(root, id).makes} made in the Mortiflix studio for its owner. Answer with the JSON asked for, nothing else. Use web search only to check a fact you aren't sure of.`,
    `## What the owner asked for (the new-project form)\n${JSON.stringify(project.intake?.answers || {}, null, 1)}`,
  ];
  parts.push(...studioContext(root, id));
  if (brief) parts.push(`## The brief, as the studio read it\n${brief.note}`);
  if (brief?.feedback) parts.push(`## The owner's answers to the brief\n${(brief.feedback.answers || []).map((a) => `- ${a.text} → ${a.answer}${a.used_default ? ' (default)' : ''}`).join('\n')}${brief.feedback.overall ? `\nOverall: ${brief.feedback.overall}` : ''}`);
  if (chat.length) parts.push(`## The owner's words in the chat since then (newest last; they win over the answers above)\n${chat.map((r) => `- ${r.text}`).join('\n')}`);
  for (const s of subs.filter((x) => !['brief', 'script'].includes(x.step) && x.feedback?.verdict === 'approve')) {
    const text = s.items.filter((it) => it.kind === 'text' && it.text).map((it) => it.text).join('\n\n').slice(0, 20_000);
    if (text) parts.push(`## Approved ${s.step} v${s.version}\n${text}`);
  }
  parts.push(`## The pipeline (follow its rules for the script step)\n${pipelineMd}`);
  parts.push(`## Checks the script must pass\n${checks.map((c) => `- ${c.id}: ${c.how}`).join('\n')}`);
  const wpm = scriptPace(root, id);
  parts.push(`## Length\n${targetSec ? `Target ${targetSec} s: about ${Math.round((targetSec / 60) * wpm)} spoken words at ${wpm} a minute (this voice's measured pace, pauses included), within 10%, with room for the holds.` : 'No length was given: choose the length the topic needs to be covered well.'}${tooLong ? `\nYour last try was ${tooLong.words} words (${tooLong.sec} s): bring it inside the target.` : ''}`);
  if (view.state === 'changes' && last) {
    const text = last.items.filter((it) => it.kind === 'text').map((it) => it.text).join('\n\n');
    parts.push(`## Version ${last.version} (the owner asked for changes)\n${text}\n\n## The owner's notes on it\n${last.feedback?.overall ? `Overall: ${last.feedback.overall}\n` : ''}${(last.feedback?.notes || []).map((n) => `${n.n}. ${n.paragraph !== undefined ? `(paragraph ${n.paragraph}) ` : ''}${n.text}`).join('\n')}\nAnswer every note in pin_changes (note number, what you changed, done/partly/not_done).`);
  }
  parts.push('Beats: one idea each, in order. `words` is exactly what is spoken; `visual` is one line on what we see. Never imitate a real brand that isn\'t the owner\'s own.');
  return parts.join('\n\n');
}

// What a session's CLAUDE.md also gives it: the preset's look and voice, the music theme, the owner's taste.
function studioContext(root, id) {
  const out = [];
  const svc = serviceBrief(root, id);
  if (svc) out.push(svc);
  const taste = existsSync(join(root, 'TASTE.md')) ? readFileSync(join(root, 'TASTE.md'), 'utf8').trim() : '';
  if (taste) out.push(`## The owner's taste (learned across projects)\n${taste}`);
  return out;
}

export function scriptMarkdown(s, version) {
  const beats = s.beats.map((b, i) => `### B${String(i + 1).padStart(2, '0')} · ${b.name.trim()}\n*${b.visual.trim().replace(/\*/g, '')}*\n\n${b.words.trim()}`);
  return `# ${s.title.trim()} · Script v${version}\n\n${s.intro.trim()}\n\n---\n\n${beats.join('\n\n')}\n`;
}

function tickChecklist(work, line, section = 'Script') {
  const f = join(work, 'checklist.md');
  if (!existsSync(f)) return;
  const lines = readFileSync(f, 'utf8').split('\n');
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${section}\\b`, 'i').test(l));
  if (at < 0) return;
  for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) lines[i] = lines[i].replace(/^- \[ \]/, '- [x]');
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end]) && lines[end].trim()) end++;
  lines.splice(end, 0, `- [x] ${line}`);
  writeFileSync(f, lines.join('\n'));
}

// Write the script with one call through `run` (the claude-code backend's run), submit it, and return the run's
// result. `fallback()` runs a normal session; it is used whenever the quick call can't finish the job.
export async function quickScript({ root, id, view, run, runArgs, config, onActivity, fallback }) {
  const pp = projectPaths(root, id);
  const intake = loadProject(root, id).intake?.answers || {};
  const targetSec = lengthSeconds(intake.length);
  const wpm = scriptPace(root, id);
  const dir = join(paths(root).run, 'quick');
  mkdirSync(dir, { recursive: true });
  const quickConfig = { ...config, claudeArgs: ['--tools', 'WebSearch WebFetch', '--allowedTools', 'WebSearch WebFetch', '--json-schema', JSON.stringify(SCHEMA)] };
  let total = { input_tokens: 0, output_tokens: 0 };
  let last = null;
  let tooLong = null;
  onActivity({ kind: 'info', text: 'Writing the script in one call.' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runAs(run, 'script', { ...runArgs, workdir: dir, prompt: scriptPrompt(root, id, view, { targetSec, tooLong }), config: quickConfig });
    last = r;
    if (runArgs.signal?.aborted) return r;
    total = { input_tokens: total.input_tokens + (r.usage?.input_tokens || 0), output_tokens: total.output_tokens + (r.usage?.output_tokens || 0) };
    if (!r.ok) break;
    const s = r.structured;
    if (!s || !Array.isArray(s.beats) || !s.beats.length || s.beats.some((b) => !String(b.words || '').trim())) { last = { ...r, ok: false, error: 'the script call gave no beats' }; break; }
    const words = s.beats.reduce((n, b) => n + countWords(b.words), 0);
    const sec = Math.round((words / wpm) * 600) / 10;
    if (targetSec && Math.abs(sec - targetSec) > targetSec * 0.1) { tooLong = { words, sec }; continue; }
    const version = view.version + 1;
    writeFileSync(join(pp.work, 'script.md'), scriptMarkdown(s, version));
    mkdirSync(join(pp.work, 'script'), { recursive: true });
    writeJson(join(pp.work, 'script', 'beats.json'), {
      beats: s.beats.map((b, i) => ({ id: `b${String(i + 1).padStart(2, '0')}`, name: b.name.trim(), words: b.words.trim(), visual: b.visual.trim(), target_sec: Math.round((countWords(b.words) / wpm) * 600) / 10 })),
    });
    const lengthNote = `${words} words ÷ ${wpm} per minute = ${sec} s${targetSec ? `, inside ${Math.round(targetSec * 0.9)}–${Math.round(targetSec * 1.1)} s (${targetSec} s ± 10%)` : ' (no target length in the brief)'}; counted by the studio.`;
    try {
      submit(root, id, 'script', {
        note: s.note,
        questions: [],
        items: [{ path: 'script.md', label: `Script v${version}` }],
        error_checks: [
          { id: 'spelling-and-facts', result: 'pass', note: s.facts_note },
          { id: 'script-fits-length', result: 'pass', note: lengthNote },
        ].filter((c) => stepChecks(root, id, 'script').some((n) => n.id === c.id)),
        pin_changes: s.pin_changes || [],
      });
    } catch (e) {
      return fallback(`the script was refused: ${e.message}`);
    }
    tickChecklist(pp.work, `Script submitted v${version} (${words} words, ~${sec} s, ${s.beats.length} beats) by the quick script call: waiting on owner`);
    appendFileSync(join(pp.work, 'JOURNAL.md'), `\n- ${new Date().toISOString()} · Script v${version} written in one quick call and submitted (${words} words, ~${sec} s, ${s.beats.length} beats).\n`);
    return { ...last, usage: total };
  }
  const r = await fallback(`the quick script didn't work (${last?.ok ? `${tooLong.words} words, ${tooLong.sec} s, off the target` : last?.error || 'no answer'})`);
  return { ...r, usage: { input_tokens: total.input_tokens + (r.usage?.input_tokens || 0), output_tokens: total.output_tokens + (r.usage?.output_tokens || 0) } };
}

// ---- the brief, the same way ----
// A full session spent five steps on it (182k tokens, almost all the same context re-read): look in input/, search the
// web twice, write notes, submit, tick the checklist. Here one call gets the new-project answers, the preset, the
// owner's taste and chat, and the pipeline's brief rules, may search the web, and returns the restatement and the
// questions; the studio submits them. Files to read (input/, the owner's assets) go to a session.

export function quickBriefStep(root, id, config) {
  if (config.quickScript === false) return null;
  const project = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  const step = pipeline.steps.find((s) => s.key === 'brief');
  if (!step || step.review !== 'questions') return null;
  const runnable = stepView(project, pipeline).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  if (runnable.length !== 1 || runnable[0].key !== 'brief') return null;
  if (project.mfx && Object.keys(project.mfx).some((k) => k.endsWith('_wanted'))) return null;
  if ((project.intake?.files || []).length) return null;
  const input = join(projectPaths(root, id).work, 'input');
  if (existsSync(input) && readdirSync(input).length) return null;
  try { if (listAssets(root, id).length) return null; } catch { /* no assets */ }
  if (stepChecks(root, id, 'brief').length) return null;
  return runnable[0];
}

export const BRIEF_SCHEMA = {
  type: 'object',
  required: ['note', 'questions'],
  properties: {
    note: { type: 'string', description: 'for the owner: the brief restated in three lines (what, for whom, the one takeaway), then a line on the questions' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text', 'choices', 'default'],
        properties: {
          id: { type: 'string', description: 'short, lowercase, e.g. tone' },
          text: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' }, description: '2-4 choices; empty for an own-words answer' },
          default: { type: 'string', description: 'one of the choices, word for word (or the suggested words when there are no choices)' },
        },
      },
    },
    research_notes: { type: 'string', description: 'Markdown: what the web search found that the script will need, with source links; empty if nothing' },
    pin_changes: {
      type: 'array',
      items: { type: 'object', required: ['note', 'change', 'status'], properties: { note: { type: 'integer' }, change: { type: 'string' }, status: { type: 'string', enum: ['done', 'partly', 'not_done'] } } },
    },
  },
};

export function briefPrompt(root, id, view) {
  const project = loadProject(root, id);
  const pp = projectPaths(root, id);
  const pipeline = projectPipeline(root, id);
  const pipelineMd = existsSync(join(pp.work, 'pipeline', 'PIPELINE.md')) ? readFileSync(join(pp.work, 'pipeline', 'PIPELINE.md'), 'utf8') : '';
  const last = submissions(root, id).filter((s) => s.step === 'brief').at(-1);
  const parts = [
    `You read the brief for "${project.title}", a ${pipeline.makes} made in the Mortiflix studio for its owner. Answer with the JSON asked for, nothing else. Search the web only for facts that change which questions to ask.`,
    `## What the owner asked for (the new-project form)\n${JSON.stringify(project.intake?.answers || {}, null, 1)}`,
    ...studioContext(root, id),
  ];
  parts.push(`## The pipeline (follow its rules for the brief step)\n${pipelineMd}`);
  if (view.state === 'changes' && last) {
    parts.push(`## Version ${last.version} (the owner asked for changes)\n${last.note}\n${JSON.stringify(last.questions)}\n\n## The owner's notes on it\n${last.feedback?.overall ? `Overall: ${last.feedback.overall}\n` : ''}${(last.feedback?.notes || []).map((n) => `${n.n}. ${n.text}`).join('\n')}\nAnswer every note in pin_changes (note number, what you changed, done/partly/not_done).`);
  }
  parts.push('Questions: only ones that change the video, each with a default the owner can just accept. Never imitate a real brand that isn\'t the owner\'s own: if the topic is someone else\'s brand, one question says how you\'ll keep it generic.');
  return parts.join('\n\n');
}

export async function quickBrief({ root, id, view, run, runArgs, config, onActivity, fallback }) {
  const pp = projectPaths(root, id);
  const dir = join(paths(root).run, 'quick');
  mkdirSync(dir, { recursive: true });
  onActivity({ kind: 'info', text: 'Reading the brief in one call.' });
  const r = await runAs(run, 'brief', { ...runArgs, workdir: dir, prompt: briefPrompt(root, id, view), config: { ...config, claudeArgs: ['--tools', 'WebSearch WebFetch', '--allowedTools', 'WebSearch WebFetch', '--json-schema', JSON.stringify(BRIEF_SCHEMA)] } });
  if (runArgs.signal?.aborted) return r;
  const s = r.ok ? r.structured : null;
  let why = !r.ok ? r.error || 'no answer' : !s?.note?.trim() || !Array.isArray(s.questions) || !s.questions.length ? 'no questions came back' : null;
  if (!why) {
    const version = view.version + 1;
    const items = [];
    if (String(s.research_notes || '').trim()) {
      mkdirSync(join(pp.work, 'research'), { recursive: true });
      writeFileSync(join(pp.work, 'research', 'brief-notes.md'), `${s.research_notes.trim()}\n`);
      items.push({ path: 'research/brief-notes.md', label: 'Early research notes' });
    }
    const questions = s.questions.map((q) => {
      const choices = (q.choices || []).map(String).filter((c) => c.trim()).slice(0, 12);
      // the default word for word as one of its choices (a different case or spacing is the same choice)
      const same = choices.find((c) => c.trim().toLowerCase() === String(q.default || '').trim().toLowerCase());
      return { id: q.id, text: q.text, ...(choices.length ? { choices } : {}), default: same ?? q.default };
    });
    try {
      submit(root, id, 'brief', { note: s.note, questions, items, error_checks: [], pin_changes: s.pin_changes || [] });
      tickChecklist(pp.work, `Brief submitted v${version} (${questions.length} questions) by the quick brief call: waiting on owner`, 'Brief');
      appendFileSync(join(pp.work, 'JOURNAL.md'), `\n- ${new Date().toISOString()} · Brief v${version} read in one quick call and submitted (${questions.length} questions).\n`);
      return r;
    } catch (e) {
      why = `the brief was refused: ${e.message}`;
    }
  }
  const f = await fallback(`the quick brief didn't work (${why})`);
  return { ...f, usage: { input_tokens: (r.usage?.input_tokens || 0) + (f.usage?.input_tokens || 0), output_tokens: (r.usage?.output_tokens || 0) + (f.usage?.output_tokens || 0) } };
}
