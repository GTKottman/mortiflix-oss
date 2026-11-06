#!/usr/bin/env node
// End-to-end beta driver: plays the owner against the Mortiflix service (stdio, like the app's bridge.mjs) through every
// v3 gate to out/final/final.mp4, in REPLAY mode. Usage:
//   node tools/replay/beta-drive.mjs [--pack DIR] [--studio DIR] [--path happy|fix|remake|faults|all] [--timeout-min N]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineClient, clip } from './drive/client.mjs';
import { StuckRecorder, spendCheck, markdown, replayGaps } from './drive/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '..', '..', 'bin', 'mortiflix-service.mjs');
const PNG = '' + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEP_STAGE = { brief: 0, script: 0, voice: 1, 'style-frames': 2, stills: 3, animatic: 4, sound: 5, artcraft: 6 };

export function parseArgs(argv) {
  const o = { pack: '/tmp/mfx-beta-studio/replay-packs/black-october', studio: '/tmp/mfx-beta-studio', path: 'happy', timeoutMin: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--pack') { o.pack = v; i++; } else if (a === '--studio') { o.studio = v; i++; }
    else if (a === '--path') { o.path = v; i++; } else if (a === '--timeout-min') { o.timeoutMin = Number(v); i++; }
  }
  return o;
}

export function cleanEnv(env, studio, pack) {
  const e = { ...env };
  for (const k of Object.keys(e)) if (/^CLAUDE_CODE/.test(k) || k === 'CLAUDECODE') delete e[k];
  for (const k of ['ELEVENLABS_API_KEY', 'ANTHROPIC_API_KEY', 'UPLOAD_POST_API_KEY']) delete e[k];
  e.MORTIFLIX_STUDIO = studio; e.MFX_REPLAY = pack;
  return e;
}

class PathAbort extends Error {}

// One walk of one project. `c` is a LineClient.
export class Walk {
  constructor({ c, name, studio, pack, deadlineMs, log = () => {} }) {
    Object.assign(this, { c, name, studio, pack, log });
    this.deadline = Date.now() + deadlineMs;
    this.stuck = new StuckRecorder(name);
    this.steps = []; this.faults = []; this.notes = []; this.expected = []; this.expectFault = null; this.resumes = 0;
    this.id = null; this.errFrom = c.errors.length; this.fixed = new Set();
    this.faultFile = join(studio, 'run', 'replay-faults.json');
  }
  // ---- plumbing ----
  step(s) { this.steps.push(s); this.log(`[${this.name}] ${s}`); }
  note(s) { this.notes.push(s); this.log(`[${this.name}] note: ${s}`); }
  setFaults(o) { mkdirSync(dirname(this.faultFile), { recursive: true }); writeFileSync(this.faultFile, JSON.stringify(o)); }
  clearFaults() { try { rmSync(this.faultFile, { force: true }); } catch {} }
  expectErr(type) { this.expected.push(type); }
  async snap() {
    const st = await this.c.soft('state.get'); const ss = await this.c.soft('stage.status');
    return { state: st.ok ? { state: st.result.state, stage: st.result.stage, line: st.result.line } : st.error, needs_you: st.ok ? st.result.needs_you : null, status: ss.ok ? ss.result.map((s) => `${s.key}:${s.kind}[${(s.steps || []).map((x) => `${x.key}=${x.state}@${x.version}`).join(',')}]`) : ss.error };
  }
  async stuckHere(step, waitingFor, note) {
    const s = await this.snap();
    return this.stuck.record({ step, waitingFor, state: s.state, status: s.status, needs_you: s.needs_you, events: this.c.recent(5), note });
  }
  // wait for fn() truthy; polls every 1 s, wakes on events; records a stuck point on timeout and returns null
  async until(step, waitingFor, fn, timeoutMs = 240000) {
    const end = Math.min(Date.now() + timeoutMs, this.deadline);
    let wake; const off = this.c.onEvent(() => wake?.());
    try {
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (await this.handlePause(step)) continue;
        if (Date.now() >= this.deadline) { await this.stuckHere(step, waitingFor, 'path deadline'); throw new PathAbort('path deadline'); }
        if (Date.now() >= end) { await this.stuckHere(step, waitingFor, 'timeout'); return null; }
        await new Promise((r) => { wake = r; setTimeout(r, 1000); });
      }
    } finally { off(); }
  }
  // the project paused: an injected fault the driver expects, or a surprise. Resume the way the UI offers (project.resume).
  async handlePause(step) {
    const st = await this.c.soft('state.get'); if (!st.ok) return false;
    const { state, needs_you } = st.result;
    if (!['paused', 'failed'].includes(state)) return false;
    const text = clip(needs_you, 400);
    // cost first (svc/paidgate.mjs): the app shows the estimate and the owner's OK is step.confirm_cost
    if (needs_you?.kind === 'cost_ok') {
      const r = await this.c.soft('step.confirm_cost', { step: needs_you.step });
      this.step(`cost OK: ${needs_you.step} (about ${needs_you.estimate_credits ?? '?'} credits) ${r.ok ? '' : 'FAILED: ' + r.error.message}`);
      if (!r.ok) await this.stuckHere(step, 'step.confirm_cost', r.error.message);
      return r.ok;
    }
    if (this.expectFault) {
      const f = this.expectFault; this.expectFault = null;
      const rec = { fault: f, surfaced: true, cause: needs_you?.cause ?? null, text: needs_you?.text ?? needs_you?.message ?? text, step, recovered: false, how: 'project.resume' };
      this.faults.push(rec);
      const r = await this.c.soft('project.resume');
      rec.recovered = r.ok; if (!r.ok) rec.how += ` failed: ${r.error.message}`;
      this.clearFaults(); this.step(`fault ${f} surfaced (${rec.cause}) -> project.resume`);
      return r.ok;
    }
    if (this.resumes >= 4) return false;
    this.resumes++;
    await this.stuckHere(step, 'project running', `project ${state} unexpectedly: ${text}; trying project.resume`);
    const r = await this.c.soft('project.resume');
    return r.ok;
  }
  async stageStatus() { return (await this.c.call('stage.status')); }
  async stepOf(key) { const ss = await this.stageStatus(); for (const s of ss) for (const x of s.steps || []) if (x.key === key) return x; return null; }
  async waitStep(key, states = ['in_review'], timeoutMs) {
    return this.until(key, `step ${key} in ${states.join('/')}`, async () => { const x = await this.stepOf(key); return x && states.includes(x.state) ? x : null; }, timeoutMs);
  }
  async afterVersion(key, v, timeoutMs = 120000) {
    return this.until(key, `step ${key} back in review after version ${v}`, async () => { const x = await this.stepOf(key); return x && x.state === 'in_review' && x.version > v ? x : null; }, timeoutMs);
  }
  async next(from, to) {
    const r = await this.c.soft('stage.set', { stage: to, from, done: true });
    if (!r.ok) { await this.stuckHere(`stage.set ${from}->${to}`, 'Next accepted', r.error.message); return null; }
    if (r.result.left?.length) this.note(`Next on stage ${from} left: ${clip(r.result.left, 200)}`);
    this.step(`Next ${from}->${to}`); return r.result;
  }
  async must(type, params, label) {
    const r = await this.c.soft(type, params); if (!r.ok) { await this.stuckHere(label || type, `${type} accepted`, r.error.message); return null; }
    return r.result;
  }
  list(x, ...keys) { if (Array.isArray(x)) return x; for (const k of keys) if (Array.isArray(x?.[k])) return x[k]; return []; }
  isFix() { return ['fix', 'all'].includes(this.mode); }

  // ---- project ----
  async create(title, pack) {
    const proj = pack.project || {};
    const r = await this.c.call('project.new', { preset: proj.pipeline || 'v3', title: `${title} (${this.name} ${new Date().toISOString().slice(11, 19)})`, answers: proj.answers || {}, start: true }, { timeout: 60000 });
    this.id = r.id ?? (typeof r.project === 'string' ? r.project : r.project?.id);
    if (!this.id) throw new Error('project.new gave no id: ' + clip(r));
    await this.c.soft('project.open', { id: this.id });
    this.step(`project.new ${this.id}`);
  }

  // ---- gates, one per stage ----
  // Stage 0: brief (UI: BriefReview -> chat.answer per question; Fix -> chat.send "Change the brief:") then script (node.edit ok per beat, Next)
  async gateBrief() {
    const b = await this.waitStep('brief'); if (!b) return false;
    let v = b.version;
    if (this.mode === 'fix' || this.mode === 'all') {
      await this.c.soft('chat.send', { text: 'Change the brief: keep it a little shorter and punchier.', context: 'video' });
      this.step('brief: Fix (chat.send)');
      const x = await this.afterVersion('brief', v, 120000); if (x) v = x.version;
    }
    const q = await this.c.soft('questions.list');
    const qs = this.list(q.result, 'questions').filter((x) => !x.answered_at);
    for (const x of qs) {
      const value = x.default ?? x.choices?.[0] ?? 'yes';
      const r = await this.c.soft('chat.answer', { question: x.id, value }); if (!r.ok) await this.stuckHere('brief', 'chat.answer accepted', r.error.message);
    }
    this.step(`brief: answered ${qs.length} questions`);
    if (!qs.length) { this.note('brief has no open questions: approving with Next'); await this.next(0, 0); }
    const gone = await this.until('brief', 'brief approved', async () => { const x = await this.stepOf('brief'); return x && x.state !== 'in_review'; }, 60000);
    if (!gone) { this.note('brief still in review after answers; Next as the fallback'); await this.next(0, 0); }
    return true;
  }
  async gateScript() {
    const s = await this.waitStep('script', ['in_review'], 300000); if (!s) return false;
    const sc = await this.c.soft('script.get'); const beats = this.list(sc.result, 'beats');
    let v = s.version;
    if (this.mode === 'fix' || this.mode === 'all') {
      if (beats[0]) {
        await this.c.soft('node.edit', { node: beats[0].id, action: 'fix', text: 'Make this opening line shorter.' });
        this.step('script: Fix (node.edit fix)');
        const x = await this.afterVersion('script', v, 180000); if (x) v = x.version;
      }
    }
    const sc2 = await this.c.soft('script.get'); for (const b of this.list(sc2.result, 'beats')) await this.c.soft('node.edit', { node: b.id, action: 'ok' });
    if (this.faultAt === 'login') { this.setFaults({ login: 1 }); this.expectFault = 'login'; }
    await this.next(0, 1);
    if (this.mode === 'remake' || this.mode === 'all') {
      const cur = await this.stepOf('script');
      const r = await this.must('stage.reopen', { stage: 0, text: 'Remake the script: different order, same facts.' }, 'script remake');
      if (r) { this.step('script: remake (stage.reopen)'); const x = await this.afterVersion('script', cur?.version ?? v, 240000); if (x) await this.next(0, 1); }
    }
    return true;
  }
  async gateVoice() {
    const s = await this.waitStep('voice', ['in_review'], 300000); if (!s) return false;
    let v = s.version;
    // music: plan -> each cue made (quote first, then confirm) -> OK -> mix (UI: music.svelte.ts, voice/basket.svelte.ts)
    let plan = await this.c.soft('music.plan.get'); let cues = this.list(plan.result, 'cues');
    if (!cues.length) { await this.c.soft('music.plan.make', {}, { timeout: 120000 }); plan = await this.c.soft('music.plan.get'); cues = this.list(plan.result, 'cues'); }
    this.step(`music plan: ${cues.length} cues`);
    for (const cue of cues) {
      if (this.faultAt === 'billing' && !this.faults.some((f) => f.fault === 'billing')) {
        // a prompt no earlier run made, so the music library has no copy and the call reaches (replayed) ElevenLabs
        await this.c.soft('music.cue.set', { cue: cue.id, prompt: `${cue.prompt || 'tense low pulse'} (beta ${Date.now()})` });
        this.setFaults({ billing: 1 });
        const r = await this.c.soft('music.cue.make', { cue: cue.id, confirm: true }, { timeout: 120000 });
        const rec = { fault: 'billing', surfaced: !r.ok || !!r.result?.error, cause: r.error?.code ?? r.result?.error?.code ?? null, text: r.error?.message ?? clip(r.result, 200), step: 'voice', recovered: false, how: 'retry music.cue.make' };
        this.faults.push(rec); if (!r.ok) this.expectErr('music.cue.make');
        this.clearFaults();
        const r2 = await this.c.soft('music.cue.make', { cue: cue.id, confirm: true }, { timeout: 120000 });
        rec.recovered = r2.ok && !r2.result?.error; this.step(`fault billing -> retry ${rec.recovered ? 'ok' : 'FAILED'}`);
      } else {
        const q = await this.c.soft('music.cue.make', { cue: cue.id }, { timeout: 60000 });
        if (q.ok && q.result?.needs_confirm) await this.c.soft('music.cue.make', { cue: cue.id, confirm: true }, { timeout: 120000 });
      }
      await this.c.soft('music.cue.ok', { cue: cue.id });
    }
    if (cues.length) await this.c.soft('music.mix', {}, { timeout: 120000 });
    if (this.isFix()) {
      const vl = await this.c.soft('voice.lines'); const lines = this.list(vl.result, 'lines');
      if (lines[0]) {
        let r = await this.c.soft('voice.line.take', { line: lines[0].id ?? lines[0].node });
        if (r.ok && (r.result?.needs_confirm || r.result?.cost)) r = await this.c.soft('voice.line.take', { line: lines[0].id ?? lines[0].node, confirm: true });
        if (!r.ok) await this.stuckHere('voice', 'voice.line.take', r.error.message);
        else { this.step('voice: Fix (voice.line.take)'); const x = await this.afterVersion('voice', v, 180000); if (x) v = x.version; }
      }
    }
    // the owner's look + motion briefs (Look panel) are set before the style frames start
    const pk = this.packJson;
    if (pk.look_brief) await this.must('look.brief.set', pk.look_brief, 'look.brief.set');
    if (pk.motion_brief) await this.must('motion.brief.set', pk.motion_brief, 'motion.brief.set');
    this.step('look + motion briefs set');
    await this.next(1, 2);
    return true;
  }
  async gateLook() {
    const s = await this.waitStep('style-frames', ['in_review'], 400000); if (!s) return false;
    let fixedOnce = false, lastChange = Date.now(), seen = '';
    const done = await this.until('style-frames', 'every look OK and the step in review', async () => {
      const f = await this.c.call('frames.get'); const fr = this.list(f, 'frames', 'items');
      const sig = fr.map((x) => `${x.id}:${x.state}:${x.version}`).join('|'); if (sig !== seen) { seen = sig; lastChange = Date.now(); }
      const review = fr.filter((x) => ['review', 'check'].includes(x.state));
      for (const x of review) {
        if ((this.mode === 'remake' || this.isFix()) && !fixedOnce) {
          fixedOnce = true;
          const text = this.mode === 'remake' ? 'Start over: a different composition, same palette.' : 'Make the title bigger.';
          const r = await this.c.soft('frames.fix', { frame: x.id, text });
          this.step(`look: ${this.mode === 'remake' ? 'remake' : 'Fix'} (frames.fix ${x.id})`);
          if (!r.ok) await this.stuckHere('style-frames', 'frames.fix', r.error.message);
        } else {
          const r = await this.c.soft('frames.ok', { frame: x.id }); if (!r.ok) await this.stuckHere('style-frames', 'frames.ok', r.error.message);
        }
        return null;
      }
      const st = await this.stepOf('style-frames');
      if (!review.length && fr.some((x) => x.state === 'ok') && Date.now() - lastChange > 45000) { await this.c.soft('frames.enough'); this.step('look: frames.enough'); lastChange = Date.now(); }
      return st?.state === 'in_review' && fr.length && !review.length && fr.every((x) => ['ok', 'cut'].includes(x.state) || x.state === undefined) ? true : null;
    }, 600000);
    if (!done) return false;
    const lk = await this.c.soft('look.get');
    if (lk.ok && !lk.result?.using) {
      const ok = this.list(lk.result, 'frames').find((x) => x.state === 'ok') || this.list(lk.result, 'frames')[0];
      if (ok) await this.must('look.use', { frame: ok.id, confirm: true }, 'look.use');
    }
    this.step('look: OK all');
    if (this.faultAt === 'render') { this.setFaults({ render: 1 }); this.expectFault = 'render'; }
    await this.next(2, 3);
    return true;
  }
  async gateStills() {
    const s = await this.waitStep('stills', ['in_review'], 400000); if (!s) return false;
    let fixedOnce = false, made = false;
    const ok = await this.until('stills', 'every still OK', async () => {
      const g = await this.c.call('stills.get'); const lines = this.list(g, 'lines');
      if (!made && lines.length && lines.every((l) => l.state === 'todo')) { made = true; await this.c.soft('stills.make'); this.step('stills: stills.make'); return null; }
      // a still whose render failed keeps state 'check' with no picture and `error` set: the UI's way out is a redraw (stills.fix)
      const failed = lines.find((l) => l.error && !l.path && l.state !== 'drawing');
      if (failed) {
        const rec = this.expectFault === 'render' ? { fault: 'render', surfaced: true, cause: null, text: failed.error, step: 'stills', recovered: false, how: 'stills.fix (redraw)' } : null;
        if (rec) { this.expectFault = null; this.clearFaults(); this.faults.push(rec); }
        else await this.stuckHere('stills', 'still render', `${failed.line} failed unexpectedly: ${failed.error}; redrawing`);
        const r = await this.c.soft('stills.fix', { line: failed.line });
        if (rec) rec.recovered = r.ok;
        this.step(`stills: ${failed.line} render failed -> stills.fix ${r.ok ? 'ok' : 'FAILED: ' + r.error.message}`);
        if (!r.ok) await this.stuckHere('stills', 'stills.fix', r.error.message);
        return null;
      }
      const rev = lines.filter((l) => ['check', 'review'].includes(l.state) && l.path);
      for (const l of rev) {
        if (this.isFix() && !fixedOnce) { fixedOnce = true; const r = await this.c.soft('stills.fix', { line: l.line, text: l.words, key_word: l.key_word }); this.step(`stills: Fix (stills.fix ${l.line})`); if (!r.ok) await this.stuckHere('stills', 'stills.fix', r.error.message); }
        else { const r = await this.c.soft('stills.ok', { line: l.line }); if (!r.ok) await this.stuckHere('stills', 'stills.ok', r.error.message); }
        return null;
      }
      return lines.length && lines.every((l) => l.state === 'ok') ? true : null;
    }, 600000);
    if (!ok) return false;
    this.step('stills: OK all');
    // the tablet fault hits the first scene's send (the studio queues it after the build)
    if (this.name === 'faults') this.setFaults({ tablet: 1 });
    await this.next(3, 4);
    return true;
  }
  async gateMotion() {
    let fixedOnce = false, remade = false, tablet = false;
    const sceneLoop = async () => this.until('animatic', 'every scene OK', async () => {
      const m = await this.c.call('motion.scene.get'); const sc = this.list(m, 'scenes');
      const rev = sc.find((x) => x.state === 'review');
      if (rev) {
        if (this.faultAt === 'tablet' && !tablet) {
          tablet = true;
          // the send runs just after the scene shows for review: wait for its outcome on the scene (as the app's poll does)
          const sent = await this.until('animatic', 'the scene\'s tablet send outcome', async () => {
            const x = this.list(await this.c.call('motion.scene.get'), 'scenes').find((y) => y.beat === rev.beat);
            return x?.tablet ? x : null;
          }, 30000);
          if (sent) rev.tablet = sent.tablet;
          // what the app shows on the scene: the failed send ('not sent' + the error), then the owner's Resend
          const rec = { fault: 'tablet', surfaced: rev.tablet?.status === 'not sent' && !!rev.tablet?.error, cause: rev.tablet?.status ?? null, text: rev.tablet?.error ?? clip(rev.tablet, 200), step: 'animatic', recovered: false, how: 'videonotes.resend' };
          this.faults.push(rec); this.clearFaults();
          const r2 = await this.c.soft('videonotes.resend', { project: this.id, scene: rev.beat });
          const after = this.list(await this.c.call('motion.scene.get'), 'scenes').find((x) => x.beat === rev.beat);
          rec.recovered = r2.ok && !!after?.tablet?.id && !after?.tablet?.error; this.step(`fault tablet -> resend ${rec.recovered ? 'ok' : 'FAILED: ' + (r2.error?.message || after?.tablet?.error)}`);
        }
        if (this.isFix() && !fixedOnce) {
          fixedOnce = true;
          const n = await this.c.soft('notes.save', { node: rev.beat, time: 1, text: 'Hold the title a beat longer.', image_png_base64: PNG, send: false });
          const sd = await this.c.soft('notes.send', { node: rev.beat });
          this.step(`motion: Fix (notes.save + notes.send ${rev.beat})`);
          if (!n.ok) await this.stuckHere('animatic', 'notes.save', n.error.message);
          if (!sd.ok) await this.stuckHere('animatic', 'notes.send', sd.error.message);
          await sleep(2000); return null;
        }
        const r = await this.c.soft('motion.scene.approve', { beat: rev.beat });
        if (!r.ok) await this.stuckHere('animatic', 'motion.scene.approve', r.error.message); else this.step(`motion: scene ${rev.beat} OK`);
        return null;
      }
      return sc.length && sc.every((x) => x.state === 'ok') ? true : null;
    }, 900000);
    const s = await this.waitStep('animatic', ['in_review'], 600000); if (!s) return false;
    if (!(await sceneLoop())) return false;
    const st = await this.waitStep('animatic', ['in_review'], 300000);
    if (this.mode === 'remake' && !remade && st) {
      remade = true;
      const r = await this.must('stage.reopen', { stage: 4, text: 'Remake the motion: calmer pace.' }, 'motion remake');
      if (r) { this.step('motion: remake (stage.reopen)'); await sleep(1500); if (!(await sceneLoop())) return false; await this.waitStep('animatic', ['in_review'], 300000); }
    }
    await this.next(4, 5);
    return true;
  }
  async gateSound() {
    const s = await this.waitStep('sound', ['in_review'], 400000); if (!s) return false;
    let plan = await this.c.soft('sfx.plan'); let cues = this.list(plan.result, 'cues');
    if (!cues.length) { await this.c.soft('sfx.plan.make', {}, { timeout: 120000 }); plan = await this.c.soft('sfx.plan'); cues = this.list(plan.result, 'cues'); }
    this.step(`sound: ${cues.length} cues planned`);
    if (cues.length) {
      const q = await this.c.soft('sfx.make', { all: true }, { timeout: 60000 });
      if (q.ok && q.result?.needs_confirm !== false) { const m = await this.c.soft('sfx.make', { all: true, confirm: true }, { timeout: 300000 }); if (!m.ok) await this.stuckHere('sound', 'sfx.make', m.error.message); }
      if (this.isFix() && cues[0]) { const r = await this.c.soft('sfx.set', { cue: cues[0].id, text: 'a little softer' }); this.step(`sound: Fix (sfx.set) ${r.ok ? 'ok' : r.error.message}`); }
      for (const cue of cues) await this.c.soft('sfx.ok', { cue: cue.id });
      await this.c.soft('sfx.mix', {}, { timeout: 120000 });
    }
    await this.next(5, 6);
    return true;
  }
  // Stage 6: Artcraft (UI: TopBar Next = stage.set {from:6, done}). The real ArtCraft CLI may be missing here: a pause
  // there is a stuck point, and final.make is tried anyway (it only needs out/animatic.mp4 + out/sound/final-mix.wav).
  async gateArtcraft() {
    const x = await this.until('artcraft', 'artcraft in review or the project delivered', async () => {
      const st = await this.c.call('state.get'); if (st.state === 'delivered') return 'delivered';
      const a = await this.stepOf('artcraft'); return a?.state === 'in_review' ? 'review' : (a?.state === 'approved' ? 'delivered' : null);
    }, 240000);
    if (x === 'review') { await this.next(6, 6); this.step('artcraft: Next'); }
    if (x === 'delivered') this.step('artcraft: delivered');
    return true;
  }
  async finish() {
    const r = await this.must('final.make', {}, 'final.make'); if (!r) return null;
    this.step('final.make');
    const st = await this.until('final', 'final.status done', async () => { const x = await this.c.call('final.status'); if (x.state === 'done') return x; if (x.error) this.lastFinalError = x.error; return null; }, 420000);
    return st;
  }

  async run(pack) {
    this.packJson = pack;
    this.faultAt = null;
    const gates = [['brief', 'gateBrief'], ['script', 'gateScript'], ['voice', 'gateVoice'], ['look', 'gateLook'], ['stills', 'gateStills'], ['motion', 'gateMotion'], ['sound', 'gateSound'], ['artcraft', 'gateArtcraft']];
    await this.create(pack.project?.title || 'Beta', pack);
    for (const [label, fn] of gates) {
      if (this.name === 'faults') this.faultAt = { script: 'login', voice: 'billing', look: 'render', motion: 'tablet' }[label];
      const ok = await this[fn]();
      if (!ok) { this.note(`gate ${label} did not complete: ending path`); break; }
    }
    return await this.finish();
  }
}

function ffprobe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
  try { const j = JSON.parse(r.stdout); return { duration: Number(j.format?.duration), types: (j.streams || []).map((s) => s.codec_type) }; } catch { return null; }
}

export function checkFinal(file) {
  if (!file || !existsSync(file)) return { ok: false, why: 'final.mp4 missing' };
  const p = ffprobe(file);
  if (!p) return { ok: false, why: 'ffprobe failed' };
  const ok = p.types.includes('video') && p.types.includes('audio') && p.duration > 3 && p.duration < 7200;
  return { ok, duration: Math.round(p.duration * 10) / 10, streams: p.types, file, ...(ok ? {} : { why: 'needs video + audio and a sane duration' }) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv);
  const paths = o.path === 'all' ? ['happy', 'fix', 'remake', 'faults'] : [o.path];
  const packJson = JSON.parse(readFileSync(join(o.pack, 'replay.json'), 'utf8'));
  const ledger = join(o.studio, 'state', 'usage-ledger.jsonl');
  const ledgerStart = existsSync(ledger) ? statSync(ledger).size : 0;
  const rlog = join(o.studio, 'run', 'replay', 'log.jsonl');
  const rlogStart = existsSync(rlog) ? statSync(rlog).size : 0;
  mkdirSync(join(o.studio, 'run', 'beta-reports'), { recursive: true });
  const errLog = createWriteStream(join(o.studio, 'run', 'beta-drive-service.log'), { flags: 'a' });
  const child = spawn(process.execPath, [SERVICE], { cwd: join(HERE, '..', '..'), env: cleanEnv(env, o.studio, o.pack), stdio: ['pipe', 'pipe', 'pipe'] });
  const pid = child.pid;
  child.stderr.pipe(errLog);
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { child.stdin.end(); } catch {} try { process.kill(pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 3000).unref(); };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  const report = { started: new Date().toISOString(), pack: o.pack, studio: o.studio, service_pid: pid, paths: [], ledger_start_byte: ledgerStart };
  let spendFailed = false;
  try {
    const c = new LineClient({ stdin: child.stdin, stdout: child.stdout });
    child.on('exit', () => c.closed = true);
    const hello = await c.call('hello', { client: 'beta-drive', version: '0.1.0', protocol: 1 }, { timeout: 30000 });
    console.error(`service up: ${clip(hello, 200)}`);
    for (const name of paths) {
      const w = new Walk({ c, name, studio: o.studio, pack: o.pack, deadlineMs: o.timeoutMin * 60000, log: (s) => console.error(s) });
      w.mode = name; const pathLedgerStart = existsSync(ledger) ? statSync(ledger).size : 0;
      let fin = null, fatal = null;
      try { fin = await w.run(packJson); } catch (e) { fatal = e; if (!(e instanceof PathAbort)) await w.stuckHere('driver', 'no exception', e.stack || e.message); }
      w.clearFaults();
      const file = fin?.file || (w.id ? join(o.studio, 'projects', w.id, 'out', 'final', 'final.mp4') : null);
      const finalChk = checkFinal(file);
      if (fin && fin.state !== 'done') finalChk.ok = false;
      const spend = spendCheck(ledger, pathLedgerStart);
      if (!spend.ok) spendFailed = true;
      report.paths.push({
        path: name, project: w.id, final: finalChk, steps: w.steps, notes: w.notes, stuck: w.stuck.points, faults: w.faults, fatal: fatal ? String(fatal.message) : null,
        protocol_errors: c.errors.slice(w.errFrom).map((e) => ({ ...e, expected: w.expected.includes(e.type) })), spend,
        usage: (await c.soft('usage.get', { range: 'all' })).result?.totals ?? null,
      });
    }
    report.spend_total = spendCheck(ledger, ledgerStart);
    report.replay_gaps = replayGaps(rlog, rlogStart);
    if (!report.spend_total.ok) spendFailed = true;
  } finally { stop(); }
  const stamp = report.started.replace(/[:.]/g, '-');
  const base = join(o.studio, 'run', 'beta-reports', stamp);
  writeFileSync(base + '.json', JSON.stringify(report, null, 2));
  const md = markdown(report); writeFileSync(base + '.md', md);
  console.log(md); console.log(`report: ${base}.{json,md}`);
  if (spendFailed) { console.error('!!! SPEND DETECTED: a ledger row is not replay:true with zero cost. Run FAILED.'); process.exitCode = 2; }
  else if (report.paths.some((p) => !p.final.ok)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exitCode = 1; });
