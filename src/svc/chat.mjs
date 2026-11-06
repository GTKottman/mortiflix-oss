// The Mortiflix chat (doc 37): one history per project from the first message to the render, in
// state/<id>/chat.jsonl. Rows: {id, at, role: user|ai|system|action|stage, text, context?, card?, refs?, edit?,
// question?}. The studio writes the AI's stage messages from the project's own events (no session cost); a typed
// message becomes a move (a Fix on the node being talked about) or gets a quick reply from the user's own Claude Code
// (`claude -p`, no tools), which may turn it into a move. Sessions still do the work: they read the chat in their brief.
import { refuseReal } from '../replay.mjs';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { command } from '../platform.mjs';
import { randomBytes } from 'node:crypto';
import { projectPaths, projectPipeline, loadProject, readEvents } from '../projects.mjs';
import { loadConfig, paths } from '../studio.mjs';
import { canvasView, nodeAction, readBeats } from '../canvas.mjs';
import { beatNames } from './beatnames.mjs';
import { submissions, answerQuestion } from '../gates.mjs';
import { PARENT_SESSION_VARS, leanArgs } from '../backends/claude-code.mjs';
import { STUDIO_MODELS, effortFor, NO_RETRY } from '../models.mjs';
import { withQuickFlags } from '../quickargs.mjs';
import { credentials, DEFAULT_MODEL } from '../backends/anthropic-api.mjs';
import { stageOf, STAGE_NAMES } from './stages.mjs';
import { readLook } from './look.mjs';
import { recordApiMessage, recordClaudeJson } from './ledger.mjs';

const ROLES = ['user', 'ai', 'system', 'action', 'stage'];
const chatFile = (root, id) => join(projectPaths(root, id).state, 'chat.jsonl');
const cursorFile = (root, id) => join(projectPaths(root, id).state, 'chat.cursor');

export function appendChat(root, id, row) {
  const r = { id: `c${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, at: new Date().toISOString(), role: ROLES.includes(row.role) ? row.role : 'system', text: String(row.text || '').slice(0, 20_000),
    ...(row.context ? { context: String(row.context).slice(0, 40) } : {}), ...(row.card ? { card: row.card } : {}), ...(row.refs?.length ? { refs: row.refs.slice(0, 50) } : {}),
    ...(row.edit ? { edit: row.edit } : {}), ...(row.question ? { question: row.question } : {}), ...(row.stage !== undefined ? { stage: row.stage } : {}) };
  mkdirSync(projectPaths(root, id).state, { recursive: true });
  appendFileSync(chatFile(root, id), JSON.stringify(r) + '\n');
  return r;
}

export function chatHistory(root, id, { limit = 200, before = null } = {}) {
  const f = chatFile(root, id);
  if (!existsSync(f)) return [];
  let rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (before) { const i = rows.findIndex((r) => r.id === before); if (i >= 0) rows = rows.slice(0, i); }
  return rows.slice(-Math.min(2000, Math.max(1, Number(limit) || 200)));
}

// The owner's words since the last session, for the session's brief (torch.mjs).
export function chatForSession(root, id, { max = 30 } = {}) {
  // Since the start of the session before this one (a message sent while it ran may not have been read).
  const events = readEvents(root, id, { limit: 5000 });
  const starts = events.map((e, i) => (e.event === 'SESSION_STARTED' ? i : -1)).filter((i) => i >= 0);
  const running = starts.length && !events.slice(starts.at(-1)).some((e) => e.event === 'SESSION_ENDED');
  const from = running ? starts.at(-2) : starts.at(-1);
  const since = from !== undefined ? events[from].t : '';
  return chatHistory(root, id, { limit: 500 }).filter((r) => r.role === 'user' && r.at >= since && !r.edit).slice(-max);
}

// ---- the AI's messages, from the project's events ----

export function initChat(root, id) {
  mkdirSync(projectPaths(root, id).state, { recursive: true });
  writeFileSync(cursorFile(root, id), '0');
}

const refsIn = (text) => [...new Set([...String(text).matchAll(/\b([bsmt]\d{2,3}(?:-\d+)?|sf\d{2,3})\b/gi)].map((m) => m[1].toLowerCase()))];

function readFrames(root, id) {
  try {
    const f = JSON.parse(readFileSync(join(projectPaths(root, id).work, 'design', 'frames.json'), 'utf8'));
    return Array.isArray(f?.frames) ? f.frames : [];
  } catch { return []; }
}

function cardFor(root, id, step, version) {
  let g;
  try { g = canvasView(root, id); } catch { return null; }
  const state = projectPaths(root, id).state;
  const abs = (v) => (v?.file ? join(state, v.file) : null);
  const cur = (n) => n.versions?.find((v) => v.v === n.current);
  const kind = step.canvas;
  let names = {};
  try { names = beatNames(root, id, readBeats(projectPaths(root, id).work, [])); } catch { /* the words alone */ }
  if (kind === 'beat' || step.key === 'script') return { kind: 'script', step: step.key, version, beats: g.order.beats.map((b, i) => ({ id: b, no: i + 1, colour: g.nodes[b].colour, words: g.nodes[b].title, name: names[b]?.name || null, target_sec: g.nodes[b].target_sec ?? null })) };
  // a look's name: what the session called it in design/frames.json, else its label
  const lookName = (f) => { const d = readFrames(root, id).find((x) => x?.id === f); return String(d?.name || g.nodes[f].label).slice(0, 80); };
  if (kind === 'frame') return { kind: 'looks', step: step.key, version, frames: g.order.frames.map((f) => ({ id: f, label: g.nodes[f].label, name: lookName(f), path: abs(cur(g.nodes[f])), beat: g.nodes[f].beat })), using: (g.order.frames.includes(readLook(root, id).using) ? readLook(root, id).using : g.order.frames[0]) || null };
  if (kind === 'shot' || kind === 'transition') return { kind: kind === 'shot' ? 'shots' : 'transitions', step: step.key, version, nodes: (kind === 'shot' ? g.order.shots : g.order.transitions).map((s) => ({ id: s, label: g.nodes[s].label, title: g.nodes[s].title, colour: g.nodes[s].colour })) };
  const sub = submissions(root, id).find((s) => s.step === step.key && s.version === version);
  if (sub) return { kind: 'submission', step: step.key, version, items: (sub.items || []).map((it) => ({ label: it.label, kind: it.kind, path: it.file ? join(state, it.file) : null })), questions: sub.questions || [] };
  return null;
}

// Turn the events since the last look into chat rows (stage dividers, the AI's messages with cards, failures).
export function translateEvents(root, id) {
  const events = readEvents(root, id, { limit: 100_000 });
  const cf = cursorFile(root, id);
  let cursor = 0;
  // A project the chat never saw starts from now (its history isn't replayed); a new one from its first event.
  try { cursor = Number(readFileSync(cf, 'utf8')) || 0; } catch { cursor = events.length; writeFileSync(cf, String(cursor)); }
  if (cursor > events.length) cursor = events.length;
  const fresh = events.slice(cursor);
  if (!fresh.length) return [];
  const pipeline = projectPipeline(root, id);
  const stepOf = (k) => pipeline.steps.find((s) => s.key === k);
  const project = loadProject(root, id);
  const rows = [];
  const say = (row) => rows.push(appendChat(root, id, row));
  // The cursor moves past an event only once its rows are in the chat (written after each one), so a failure part-way
  // never skips the events after it; an event that cannot be turned into rows is logged and passed over.
  let at = cursor;
  for (const e of fresh) {
    at++;
    try { translateOne(e); } catch (err) { console.error(`chat: event ${e.event} could not be shown: ${err.message}`); }
    writeFileSync(cf, String(at));
  }
  return rows;

  function translateOne(e) {
    const step = e.step ? stepOf(e.step) : null;
    switch (e.event) {
      case 'STARTED':
        say({ role: 'stage', text: STAGE_NAMES[0], stage: 0 });
        say({ role: 'ai', text: `Starting "${project.title}" (${pipeline.name}). I'll go ahead with sensible defaults; change anything at any time.` });
        break;
      case 'SUBMITTED': {
        if (!step) break;
        // With mfxQuestionsBlock: false, questions that all have defaults go on at once: the service says so itself.
        if (step.review === 'questions' && loadConfig(root).mfxQuestionsBlock === false
          && submissions(root, id).find((x) => x.step === step.key && x.version === e.version)?.questions.every((q) => q.default !== null)) break;
        const card = cardFor(root, id, step, e.version);
        // Otherwise they wait: nothing is ticked for the owner, and the next step starts after the last answer.
        if (step.review === 'questions' && card?.kind === 'submission' && card.questions.length) card.waiting = true;
        const text = card?.waiting ? `A few questions first. Pick an answer to each one (the suggested one is marked): the ${(pipeline.steps.find((x) => (x.after || []).includes(step.key))?.name || 'next step').toLowerCase()} starts once they're all answered.`
          : card?.kind === 'script' ? `${e.version > 1 ? `Script v${e.version}` : 'The script'} is ready in the Mortiflix Script box: ${card.beats.length} scene${card.beats.length === 1 ? '' : 's'}.`
          : card?.kind === 'looks' ? `${card.frames.length} looks from the script: style samples (colours, characters, type), not the shots. I'm using ${card.frames.find((f) => f.id === card.using)?.name || card.frames[0]?.name || 'the first'}; pick another any time.`
            : card?.kind === 'shots' ? `${card.nodes.length} shots are in. Walk through them: OK, Fix or Cut it on each one.`
              : `${step.name} v${e.version} is ready.`;
        // The script itself is in the Mortiflix Script box: the chat only says so, without listing it again (owner, 2026-10-18).
        say({ role: 'ai', text, card: card?.kind === 'script' ? undefined : card, refs: card?.nodes?.map((n) => n.id) || card?.beats?.map((b) => b.id) || [], stage: stageOf(step) });
        break;
      }
      case 'ASKED': {
        const q = [...project.questions].reverse().find((x) => x.step === e.step && x.text.startsWith(String(e.details).slice(0, 60)));
        if (q) say({ role: 'ai', text: q.text, question: { id: q.id, choices: q.choices, default: q.default }, card: { kind: 'question', id: q.id, choices: q.choices, default: q.default } });
        break;
      }
      case 'STEP_DONE': if (step) say({ role: 'system', text: `${step.name} done.` }); break;
      case 'NEEDS_YOU': say({ role: 'system', text: `Needs you: ${e.details}` }); break;
      case 'EDIT_DONE': {
        const m = String(e.details).match(/^(E\d+) on ([^:]+)/);
        say({ role: 'ai', text: `${m?.[2] || 'A piece'} is remade${m ? ` (${m[1]})` : ''}.`, refs: refsIn(e.details), edit: m?.[1] || null, card: { kind: 'versions', edit: m?.[1] || null, refs: refsIn(e.details) } });
        break;
      }
      case 'EDIT_FAILED': say({ role: 'system', text: `Couldn't remake it: ${e.details}`, refs: refsIn(e.details) }); break;
      case 'MUSIC_THEME': if (e.actor !== 'you') say({ role: 'ai', text: `Music theme: ${e.details}.`, card: { kind: 'themes' } }); break;
      case 'DELIVERED_FROM_APP': case 'DELIVERED_FROM_EDIT': say({ role: 'ai', text: `The video is rendered: ${e.details}` }); break;
      case 'SESSION_ENDED': if (/^error/.test(e.details)) say({ role: 'system', text: `The AI stopped: ${String(e.details).replace(/^error: /, '')}` }); break;
      default: break;
    }
  }
}

// ---- typed messages ----

const ACTIONS = { ok: 'OK', fix: 'Fix', cut: 'Cut it', clear: 'Undo' };

// What a typed message becomes. In a node context it is a Fix on that node (doc 37 "Typing becomes a move, and says
// so"), unless the node is OK'd: then it asks first. In the whole video it goes to the AI for a quick reply.
export function typedMove(root, id, { text, context, confirm = false }) {
  if (!context || context === 'video' || String(context).startsWith('stage:')) return null;
  const g = canvasView(root, id);
  // A cut between two shots: a Fix on its transition when the board has one, else the AI answers (it may pick a move).
  if (String(context).startsWith('cut:')) {
    const [, from, to] = String(context).split(':');
    const t = g.order.transitions.find((x) => g.nodes[x]?.from === from && g.nodes[x]?.to === to);
    if (!t) return null;
    context = t;
  }
  const n = g.nodes[context];
  if (!n) return { reply: { role: 'system', text: `There's no ${context} any more: talking about the whole video.` } };
  if (n.owner === 'ok' && !confirm) {
    return { reply: { role: 'ai', text: `${n.label} is OK'd. Remake it anyway?`, context, question: { id: `remake:${context}`, choices: ['Remake it', 'Keep it'], default: 'Keep it', text }, card: { kind: 'confirm', node: context, text } } };
  }
  const r = nodeAction(root, id, context, { action: 'fix', text });
  return { move: { kind: 'fix', node: context, edit: r.edit.id }, reply: { role: 'system', text: `Sent as Fix on ${n.label} (${r.edit.id}).`, context, edit: r.edit.id, refs: [context] } };
}

export const actionText = (action, label, text) => `${ACTIONS[action] || action} on ${label}${text ? `: ${String(text).slice(0, 200)}` : ''}`;

// The "talking about" target in words for the quick reply's brief.
export function contextWords(context) {
  const c = String(context || 'video');
  if (c === 'video') return 'the whole video';
  if (c.startsWith('cut:')) { const [, a, b] = c.split(':'); return `the cut between ${a.toUpperCase()} and ${b.toUpperCase()} (no transition picked yet)`; }
  if (c.startsWith('stage:')) return `the ${c.slice(6)} stage`;
  return c;
}

// The context the quick reply gets: short, from the graph and the project, never file contents.
function briefFor(root, id, context) {
  const project = loadProject(root, id);
  let g = { order: { beats: [], shots: [] }, nodes: {} };
  try { g = canvasView(root, id); } catch { /* nothing yet */ }
  const beats = g.order.beats.map((b, i) => `${i + 1}. ${b}: ${String(g.nodes[b].title || '').slice(0, 160)}`).join('\n');
  const shots = g.order.shots.map((s) => `${s} (${g.nodes[s].state}${g.nodes[s].owner ? `, ${g.nodes[s].owner}` : ''})`).join(', ');
  const open = project.questions.filter((q) => !q.answered_at).map((q) => `${q.id}: ${q.text}${q.default ? ` (default ${q.default})` : ''}`).join('\n');
  const recent = chatHistory(root, id, { limit: 12 }).map((r) => `${r.role}: ${r.text.slice(0, 300)}`).join('\n');
  return `Project "${project.title}" (${project.pipeline.name}), state ${project.state}.\nBeats:\n${beats || '(none yet)'}\nShots: ${shots || '(none yet)'}\nOpen questions:\n${open || '(none)'}\nTalking about: ${contextWords(context)}\nRecent chat:\n${recent}`;
}


const SYSTEM = `You are the Mortiflix assistant inside a video app. The owner typed a message about their video. Reply in one or two short plain sentences. If the message asks for a change to one piece, also pick a move. Never post or publish anything. Answer ONLY with JSON: {"reply": "...", "move": null | {"kind": "fix", "node": "<id>", "text": "<what to change>"} | {"kind": "answer", "question": "<q id>", "value": "<answer>"}}. Use node ids exactly as listed (b01, s03, t02, m01, sf01, line ids).`;

function parseReply(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { const j = JSON.parse(s.slice(a, b + 1)); if (typeof j.reply === 'string') return { reply: j.reply.slice(0, 4000), move: j.move && typeof j.move === 'object' ? j.move : null }; } catch { /* plain text */ } }
  return { reply: s.trim().slice(0, 4000) || '(no answer)', move: null };
}

// One short call to the user's own AI. Backends: claude-code (`claude -p`, no tools, no saved session), anthropic-api
// (the fallback key), demo (canned, free). `config.chatBackend` overrides the studio's backend.
export async function quickReply(root, id, { text, context }) {
  const config = loadConfig(root);
  const backend = config.chatBackend || loadProject(root, id).backend || config.backend;
  const prompt = `${briefFor(root, id, context)}\n\nThe owner says:\n<<<\n${String(text).slice(0, 8000)}\n>>>`;
  if (backend === 'demo') {
    const m = String(text).match(/\b(s\d{2,3}|b\d{2,3}|t\d{2,3}|m\d{2,3}|sf\d{2,3})\b/i);
    return m ? { reply: `Demo: I'll change ${m[1].toUpperCase()} for you.`, move: { kind: 'fix', node: m[1].toLowerCase(), text } }
      : { reply: 'Demo: noted. The AI reads this before its next piece of work.', move: null };
  }
  if (backend === 'anthropic-api') {
    const { key } = credentials(root);
    if (!key) throw new Error('no Anthropic API key: link Claude Code in Setup, or add a key');
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    refuseReal('the Anthropic API (chat)');
    const client = new Anthropic({ apiKey: key, maxRetries: 2 });
    const r = await client.messages.create({ model: config.chatModel || config.model || DEFAULT_MODEL, max_tokens: 600, system: SYSTEM, messages: [{ role: 'user', content: prompt }] });
    recordApiMessage(root, id, r, { role: 'chat' });
    return parseReply(r.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  }
  const j = await askClaude(config, 'chat', ['-p', `${SYSTEM}\n\n${prompt}`, '--output-format', 'json', '--tools', '', '--no-session-persistence'], quickDir(root, config, id), { root, project: id });
  if (j.is_error) throw new Error(String(j.result || j.error || 'Claude Code failed').slice(0, 300));
  return parseReply(j.result);
}

// One short question to the user's own AI with no tools (beat names): the answer's text. claude-code or anthropic-api.
// `stage` (a stage key, e.g. voiceMusic) books the call on that stage; else the ledger guesses the project's current one.
export async function askAI(root, id, prompt, { maxTokens = 400, role = null, stage = null } = {}) {
  const config = loadConfig(root);
  const backend = config.chatBackend || loadProject(root, id).backend || config.backend;
  if (backend === 'demo') return '';
  if (backend === 'anthropic-api') {
    const { key } = credentials(root);
    if (!key) throw new Error('no Anthropic API key');
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    refuseReal('the Anthropic API (chat)');
    const client = new Anthropic({ apiKey: key, maxRetries: 1 });
    const r = await client.messages.create({ model: config.chatModel || config.model || DEFAULT_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    recordApiMessage(root, id, r, { role, stage });
    return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const j = await askClaude(config, role, ['-p', prompt, '--output-format', 'json', '--tools', '', '--no-session-persistence'], quickDir(root, config, id), { timeoutMs: 120_000, root, project: id, stage });
  if (j.is_error) throw new Error(String(j.result || 'Claude Code failed').slice(0, 300));
  return String(j.result || '');
}

// One quick answer with no project behind it (the New project brief's "Improve my brief"). Same backends and models as askAI.
export async function askAnon(root, prompt, { role = 'options', maxTokens = 900 } = {}) {
  const config = loadConfig(root);
  const backend = config.chatBackend || config.backend;
  if (backend === 'demo') return '';
  if (backend === 'anthropic-api') {
    const { key } = credentials(root);
    if (!key) throw new Error('no Anthropic API key');
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    refuseReal('the Anthropic API (chat)');
    const client = new Anthropic({ apiKey: key, maxRetries: 1 });
    const r = await client.messages.create({ model: config.chatModel || config.model || DEFAULT_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    recordApiMessage(root, null, r, { role });
    return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const dir = join(paths(root).run, 'quick', '_shared');
  mkdirSync(dir, { recursive: true });
  const j = await askClaude(config, role, ['-p', prompt, '--output-format', 'json', '--tools', '', '--no-session-persistence'], dir, { timeoutMs: 90_000, root, project: null });
  if (j.is_error) throw new Error(String(j.result || 'Claude Code failed').slice(0, 300));
  return String(j.result || '');
}

// One quick `claude -p` call as JSON. `role` (chat, name, lesson: STUDIO_MODELS) picks the cheap model and its effort; the
// owner's config.chatModel / config.model still win. Run again on the default model only when the cheap one's answer is
// missing or not JSON: a timeout, billing or login error would fail the same way. A role of null = the default model, as before.
async function askClaude(config, role, args, cwd, opts) {
  const fixed = config.chatModel || config.model;
  const model = fixed || (role ? (config.models ?? STUDIO_MODELS)[role] : null);
  const effort = fixed ? null : role ? effortFor(config, role) : null;
  const once = async (m, e) => {
    const out = await runClaude(config, [...args, ...(m ? ['--model', m] : []), ...(e ? ['--effort', e] : [])], cwd, opts);
    const j = JSON.parse(out);
    if (opts?.root) recordClaudeJson(opts.root, opts.project, j, { role, model: m, stage: opts.stage || null });
    if (!j.is_error && !String(j.result || '').trim()) throw new Error('Claude Code gave no answer');
    return j;
  };
  try { return await once(model, effort); } catch (e) {
    if (fixed || !role || !model || NO_RETRY.test(e.message)) {
      if (e instanceof SyntaxError) throw new Error('Claude Code answered something that is not JSON');
      throw e;
    }
    return once(null, null);
  }
}

// Where a quick call runs: lean, a folder of its own (the project's CLAUDE.md and skills are for sessions; the
// prompt already carries what a reply needs); config.leanSessions: false keeps the project folder.
function quickDir(root, config, id) {
  if (config.leanSessions === false) return projectPaths(root, id).work;
  const dir = join(paths(root).run, 'quick', '_shared'); // one folder for every project: the same system prompt, cached
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A quick call starts lean like a session (no MCP servers, plugins, skills or global CLAUDE.md of your own): a chat
// reply went from about 59k tokens to 3k.
export function runClaude(config, args, cwd, { timeoutMs = 180_000 } = {}) {
  if (config.leanSessions !== false) args = [...withQuickFlags(leanArgs(args, config))];
  return new Promise((ok, fail) => {
    const env = { ...process.env };
    for (const k of PARENT_SESSION_VARS) delete env[k];
    let p;
    try { const c = command(config.claudeBin || 'claude', args, { env }); p = spawn(c.file, c.args, { ...c.options, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { fail(e); return; }
    let out = '';
    let err = '';
    const t = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* gone */ } fail(new Error('Claude Code took too long to answer')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > 4_000_000) p.kill('SIGTERM'); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); fail(new Error(`Claude Code isn't installed or can't start (${e.code || e.message})`)); });
    p.on('close', (code) => { clearTimeout(t); if (code === 0) ok(out); else fail(new Error(`Claude Code stopped (${code}): ${(err || out).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)); });
  });
}

// Run the move a reply picked. Approved pieces are never changed without asking (doc 37 rule 4).
export function applyMove(root, id, move) {
  if (!move) return null;
  if (move.kind === 'fix') {
    const g = canvasView(root, id);
    const n = g.nodes[String(move.node || '')];
    if (!n || !String(move.text || '').trim()) return null;
    if (n.owner === 'ok') return { asked: true, row: { role: 'ai', text: `${n.label} is OK'd. Remake it anyway?`, context: n.id, question: { id: `remake:${n.id}`, choices: ['Remake it', 'Keep it'], default: 'Keep it', text: String(move.text) }, card: { kind: 'confirm', node: n.id, text: String(move.text) } } };
    const r = nodeAction(root, id, n.id, { action: 'fix', text: String(move.text) });
    return { kind: 'fix', node: n.id, edit: r.edit.id, row: { role: 'system', text: `Sent as Fix on ${n.label} (${r.edit.id}).`, context: n.id, edit: r.edit.id, refs: [n.id] } };
  }
  if (move.kind === 'answer') {
    const q = loadProject(root, id).questions.find((x) => x.id === move.question && !x.answered_at);
    if (!q) return null;
    answerQuestion(root, id, q.id, String(move.value ?? ''));
    return { kind: 'answer', question: q.id, row: { role: 'system', text: `Answered: ${q.text} → ${move.value}` } };
  }
  return null;
}
