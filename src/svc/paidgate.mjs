// Cost first for the steps the runner starts by itself (owner, 2026-11-02: the voice step ran 14 ElevenLabs calls the
// moment the last script scene was OK'd, with no voice pick and no cost OK; the New project screen promises "nothing
// paid starts from this form" and "with your OK on the cost first"). Before a step that spends ElevenLabs starts on its
// own, the project waits: needs_you {kind:'cost_ok', step, estimate_credits, voice?}. It goes on only after
// `step.confirm_cost {project, step}` (or `voice.make {confirm:true}`), which books the OK for the step's next version.
// The OK is also a budget: the voice step records at most the credits OK'd (a bigger plan asks again).
// config.json `paid.ask_first` (default true) turns this off. Re-generations (New take, Remake line, Make cue, Make
// sound) already ask in the app (CostPrompt) and never pass through here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig, studioRoot, UserError } from '../studio.mjs';
import { loadProject, projectPaths, projectPipeline, update, event, now } from '../projects.mjs';
import { stepView } from '../gates.mjs';
import { voiceConfig, elevenKey } from '../voice/index.mjs';
import { voiceStepEstimate } from './voicecost.mjs';
import { creditsFor as musicCredits, cueLength, musicBatch } from './elmusic.mjs';
import { creditsFor as sfxCredits, soundPaths } from './sfx.mjs';
import { musicExpected } from './musicneed.mjs';
import { creditsToday } from './ledger.mjs';

export const PAID_STEPS = ['voice', 'music', 'sound'];
const readOr = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function askFirst(root) {
  try { return loadConfig(root).paid?.ask_first !== false; } catch { return true; }
}

// The daily credit cap (owner, 2026-11-03: "If a daily credit cap would be something that someone would use, of course
// we should add it"): config.json `paid.daily_cap`, ElevenLabs credits per local day; null or 0 = no cap. Today's spend
// is the usage ledger's ElevenLabs credits booked today (svc/ledger.mjs creditsToday). Checked here only: at the one-time
// quote (takeQuote), at the step OK (confirmCost) and before a paid step starts by itself (paidGate).
export function dailyCap(root) {
  try { const v = Number(loadConfig(root).paid?.daily_cap); return Number.isFinite(v) && v > 0 ? Math.floor(v) : null; } catch { return null; }
}
const fmt = (n) => Math.round(n).toLocaleString('en-US');
// null = within the cap (or no cap); else {cap, spent, need, message}
function overCap(root, credits) {
  const cap = dailyCap(root);
  const need = Math.max(0, Number(credits) || 0);
  if (!cap || !need) return null;
  const spent = creditsToday(root);
  if (spent + need <= cap) return null;
  return { cap, spent, need, message: `This would go over today's credit cap: ${fmt(spent)} of ${fmt(cap)} used, this needs ${fmt(need)}. Nothing was made. Raise the cap in Settings, or wait until tomorrow.` };
}
export function checkCap(root, credits) {
  const o = overCap(root, credits);
  if (o) throw Object.assign(new UserError(o.message), { code: 'credit_cap', cap: o.cap, spent: o.spent, credits: o.need });
}
// Settings: {daily_cap, spent_today}
export const capSettings = (root) => ({ daily_cap: dailyCap(root), spent_today: creditsToday(root) });
export function saveDailyCap(root, value) {
  const v = value === null || value === '' || value === 0 ? null : Number(value);
  if (v !== null && (!Number.isInteger(v) || v < 1 || v > 100_000_000)) throw new UserError('paid.daily_cap is a whole number of credits (empty or 0 = no cap)');
  const saved = loadConfig(root).paid || {};
  saveConfig(root, { paid: { ...saved, daily_cap: v } });
  return capSettings(root);
}

const WHAT = { voice: 'the voice', music: 'the music', sound: 'the new sounds' };

// What a step would spend if it started now: {step, estimate_credits, characters?, lines?, voice?}, or null when it is
// free (nothing to record, or not ElevenLabs). `session`: a full session would do the step (it gets the ElevenLabs key);
// the studio's own quick music and sound paths make nothing paid, so only a session makes music or sound cost.
export function stepEstimate(root, id, step, { session = false } = {}) {
  const v = voiceConfig(root);
  if (step === 'voice') {
    if (v.engine !== 'elevenlabs') return null;
    const e = voiceStepEstimate(root, id);
    if (!e.needs_confirm) return null;
    return { step, estimate_credits: e.credits_estimate, characters: e.characters, lines: e.lines.length, voice: e.voice };
  }
  if (!session || !elevenKey(root)) return null;
  const work = projectPaths(root, id).work;
  // v3: the voice step makes the music whatever the sessions' Eleven Music switch says (svc/musicneed.mjs)
  const expected = step === 'music' && musicExpected(root, id);
  if (step === 'music' && (v.elevenlabs.music || expected)) {
    const cues = readOr(join(work, 'music', 'cues.json'), null)?.cues;
    const seconds = Array.isArray(cues) && cues.length ? null : readOr(join(work, 'voice', 'timing.json'), {}).seconds;
    // v3 makes the cues not made yet (the rest are paid for); all made: nothing to pay
    // ... and only what music.make makes now: the first music alone, the rest once it is OK'd (musicBatch)
    const todo = Array.isArray(cues) && expected ? musicBatch(cues).todo : cues;
    if (expected && Array.isArray(cues) && cues.length && !todo.length) return null;
    const credits = Array.isArray(cues) && cues.length ? todo.reduce((n, c) => n + musicCredits(cueLength(c)), 0) : seconds ? musicCredits(seconds) : null;
    return { step, estimate_credits: credits, ...(expected ? { cues: Array.isArray(cues) ? cues.length : 0, to_make: Array.isArray(todo) ? todo.length : 0 } : {}) };
  }
  if (step === 'sound' && v.elevenlabs.sfx) {
    const plan = readOr(soundPaths(work).plan, null);
    const cues = (plan?.cues || []).filter((c) => c.source === 'generate' && c.status === 'planned');
    return plan ? (cues.length ? { step, estimate_credits: cues.reduce((n, c) => n + sfxCredits(c), 0) } : null) : { step, estimate_credits: null };
  }
  return null;
}

// The pipeline step a paid step's OK is booked on: v3 makes the music in the voice step (it has no music step).
const bookedOn = (steps, step) => steps.find((x) => x.key === step) || (step === 'music' ? steps.find((x) => x.key === 'voice' && x.stage === 'voiceMusic') : null);

// The OK the owner gave for this step's next version (or null).
export function costOk(project, step, version) {
  const ok = project.cost_ok?.[step];
  return ok && ok.version === version ? ok : null;
}

// Called by the runner before a session: the paid step that must wait for the owner's OK, or null.
// `quickSteps`: the steps the studio's own (free) quick paths will do now.
export function paidGate(root, id, { backend, quickSteps = [] } = {}) {
  if (backend === 'demo') return null;
  const ask = askFirst(root);
  if (!ask && !dailyCap(root)) return null;
  const project = loadProject(root, id);
  const runnable = stepView(project, projectPipeline(root, id)).filter((s) => ['ready', 'working', 'changes'].includes(s.state));
  for (const s of runnable) {
    if (!PAID_STEPS.includes(s.key)) continue;
    const est = stepEstimate(root, id, s.key, { session: !quickSteps.includes(s.key) });
    if (!est) continue;
    // over today's credit cap: the project waits (even with an OK given earlier, with ask_first off, or for a remake)
    const cap = overCap(root, est.estimate_credits);
    if (cap) return { ...est, version: s.version + 1, cap: `This would go over today's credit cap (${fmt(cap.spent)} of ${fmt(cap.cap)} used, this needs ${fmt(cap.need)}). Raise it in Settings or wait until tomorrow, then press Resume.` };
    // a remake after the owner's notes is a re-generation the owner asked for (their notes in the app): no cost OK
    if (s.state === 'changes' || !ask) continue;
    const ok = costOk(project, s.key, s.version + 1);
    // the OK covers what it said (10% and a few credits of slack for a changed comma); a bigger plan asks again
    if (ok && (est.estimate_credits ?? 0) <= Math.ceil((ok.credits ?? 0) * 1.1) + 5) continue;
    return { ...est, version: s.version + 1 };
  }
  return null;
}

export function costText(g) {
  if (g.cap) return g.cap;
  return `Waiting for your OK on the cost: ${WHAT[g.step] || g.step}${g.voice?.name ? ` (${g.voice.name})` : ''}, ${g.estimate_credits != null ? `about ${g.estimate_credits} ElevenLabs credits` : 'ElevenLabs credits (the amount is known once the plan is made)'}. Nothing is made until you press ${g.step === 'voice' ? 'Make the voice' : 'Make it'}.`;
}

// Pause the project for the OK. The runner never starts the step until step.confirm_cost.
export function waitForCost(root, id, g) {
  return update(root, id, (p) => {
    p.state = 'paused';
    // a cap stop is its own kind: no cost OK moves it on, Resume does (it checks the cap again)
    p.needs_you = { text: costText(g), at: now(), kind: g.cap ? 'credit_cap' : 'cost_ok', cause: g.cap ? 'credit_cap' : 'cost_ok', step: g.step, estimate_credits: g.estimate_credits ?? null,
      ...(g.characters != null ? { characters: g.characters, lines: g.lines } : {}), ...(g.voice ? { voice: g.voice } : {}) };
    event(root, id, { event: 'NEEDS_YOU', details: p.needs_you.text });
    return p.needs_you;
  });
}

// The owner's OK on the cost: booked for the step's next version, then the project goes on.
export function confirmCost(root, id, step) {
  if (!PAID_STEPS.includes(step)) throw Object.assign(new Error(`step must be ${PAID_STEPS.join(', ')}`), { code: 'bad' });
  const project = loadProject(root, id);
  const s = bookedOn(stepView(project, projectPipeline(root, id)), step);
  if (!s) throw Object.assign(new Error(`this project has no ${step} step`), { code: 'bad' });
  const est = stepEstimate(root, id, step, { session: true }) || { estimate_credits: 0 };
  checkCap(root, est.estimate_credits);
  return update(root, id, (p) => {
    p.cost_ok = { ...(p.cost_ok || {}), [step]: { at: now(), version: s.version + 1, credits: est.estimate_credits ?? null, ...(est.voice ? { voice: est.voice } : {}) } };
    let resumed = false;
    if (p.state === 'paused' && p.needs_you?.kind === 'cost_ok') { p.state = 'queued'; p.needs_you = null; p.no_progress = 0; p.last_failure = null; resumed = true; }
    event(root, id, { event: 'COST_OK', actor: 'you', step, details: `${WHAT[step] || step}: about ${est.estimate_credits ?? '?'} ElevenLabs credits` });
    return { step, credits: est.estimate_credits ?? null, version: s.version + 1, resumed };
  });
}

// The credits the owner OK'd for the voice now (the cap the voice step records under), or null when nothing caps it.
export function voiceBudget(root, id) {
  if (!askFirst(root)) return null;
  const project = loadProject(root, id);
  const s = stepView(project, projectPipeline(root, id)).find((x) => x.key === 'voice');
  const ok = s && costOk(project, 'voice', s.version + 1);
  return ok ? Math.ceil((ok.credits ?? 0) * 1.1) + 5 : null;
}

// One-time price quotes for the paid calls the owner starts from a screen (sfx.make, music.cue.make, voice.line.set).
// A call with `confirm: true` pays only for what a call without it priced moments before: the same project, the same
// thing to make (`what`, a fingerprint of exactly what would be paid for) and no more credits than shown (the same 10%
// and a few credits of slack as the step OK above; a free quote covers nothing paid). Each quote pays once, so a
// re-sent or double-clicked confirm, a plan changed since the price was shown, or a client that never asked the price
// gets an error and spends nothing (IETF draft-ietf-httpapi-idempotency-key-header: a key MUST NOT be reused with a
// different payload; the resource publishes its expiry). Quotes live in memory and expire after QUOTE_TTL_MS.
export const QUOTE_TTL_MS = 24 * 3600_000;
const quotes = new Map();
const quoteKey = (project, kind, what) => `${project}|${kind}|${JSON.stringify(what)}`;
export function rememberQuote(project, kind, what, credits) {
  const at = Date.now();
  for (const [k, q] of quotes) if (at - q.at > QUOTE_TTL_MS) quotes.delete(k);
  if (quotes.size >= 2000) quotes.delete(quotes.keys().next().value);
  quotes.set(quoteKey(project, kind, what), { credits: Math.max(0, Number(credits) || 0), at });
}
// `root`: the studio whose daily credit cap applies (default: this service's studio, MORTIFLIX_STUDIO).
export function takeQuote(project, kind, what, credits, root = studioRoot()) {
  const k = quoteKey(project, kind, what);
  const q = quotes.get(k);
  const need = Math.max(0, Number(credits) || 0);
  const live = q && Date.now() - q.at <= QUOTE_TTL_MS;
  if (!live || need > (q.credits > 0 ? Math.ceil(q.credits * 1.1) + 5 : 0)) {
    throw Object.assign(new Error(live
      ? `the cost changed since you saw it: now about ${need} ElevenLabs credits, the price shown was ${q.credits}. Nothing was made: ask the price again`
      : 'nothing was made: there is no price you saw for exactly this (it changed, it was made already, or the service restarted since). Ask the price again'), { code: 'cost_changed', credits: need });
  }
  checkCap(root, need); // over the cap: refused, and the quote stays (the same price works once the cap is raised)
  quotes.delete(k);
}

// The owner has OK'd the cost of this step's next version (the app hides its Make button then).
export function okNow(root, id, step) {
  const project = loadProject(root, id);
  const s = bookedOn(stepView(project, projectPipeline(root, id)), step);
  return Boolean(s && costOk(project, step, s.version + 1));
}
