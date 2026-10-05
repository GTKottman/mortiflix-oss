// The runner: picks the next project that has work, starts one session for it, and repeats. Sessions end at gates,
// so a project waiting on you costs nothing. One session at a time, first in first out.
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, readSessionEnv } from './studio.mjs';
import { listProjects, loadProject, projectPaths, projectPipeline, update, event, readEvents, now } from './projects.mjs';
import { settle } from './gates.mjs';
import { prepareWorkdir, writeTorch, sessionReason } from './torch.mjs';
import { openBridge } from './bridge.mjs';
import { RenderQueue } from './renderq.mjs';
import * as claudeCode from './backends/claude-code.mjs';
import * as anthropicApi from './backends/anthropic-api.mjs';
import * as demo from './backends/demo.mjs';

export const BACKENDS = { 'claude-code': claudeCode, 'anthropic-api': anthropicApi, demo };
const PROGRESS = ['SUBMITTED', 'STEP_DONE', 'ASKED', 'NEEDS_YOU', 'HANDOFF'];
const GATE_PROGRESS = ['SUBMITTED', 'STEP_DONE', 'ASKED', 'NEEDS_YOU'];
const MAX_SESSIONS_WITHOUT_GATE = 8;

export class Runner extends EventEmitter {
  constructor(root, { log = () => {} } = {}) {
    super();
    this.root = root;
    this.log = log;
    this.current = null;
    this.activity = new Map(); // project id -> recent activity lines
    this.renders = new RenderQueue({ logDir: join(paths(root).run, 'renders'), onChange: () => this.emit('change') });
  }

  // Only one runner per studio (the web server and `mortiflix run` would otherwise start two sessions at once).
  acquire() {
    const lock = join(paths(this.root).run, 'runner.pid');
    mkdirSync(paths(this.root).run, { recursive: true });
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (pid && pid !== process.pid && alive(pid)) throw new Error(`another Mortiflix runner (pid ${pid}) is already running this studio`);
    }
    writeFileSync(lock, String(process.pid));
    this.lockFile = lock;
    // Sessions that were running when the last runner died are over: say so in their log.
    for (const p of listProjects(this.root)) {
      if (p.session?.running) {
        update(this.root, p.id, (x) => { x.session = null; });
        event(this.root, p.id, { event: 'SESSION_ENDED', details: 'interrupted (the studio was stopped)' });
      }
    }
  }

  release() {
    if (this.lockFile && existsSync(this.lockFile) && readFileSync(this.lockFile, 'utf8') === String(process.pid)) rmSync(this.lockFile);
  }

  next() {
    return listProjects(this.root)
      .filter((p) => p.state === 'queued')
      .sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)))[0] || null;
  }

  // Run sessions until nothing is runnable. With `watch`, keep looking for new work until stopped.
  async loop({ watch = false, pollMs = 1500 } = {}) {
    this.stopping = false;
    while (!this.stopping) {
      const p = this.next();
      if (p) await this.runSession(p.id);
      else if (!watch) break;
      else await new Promise((ok) => { this.poke = ok; setTimeout(ok, pollMs); });
      this.poke = null;
    }
  }

  wake() { this.poke?.(); }

  async stop() {
    this.stopping = true;
    this.current?.abort.abort();
    this.wake();
    while (this.current) await new Promise((ok) => setTimeout(ok, 100));
  }

  // Stop the session working on one project (pause / cancel from the UI).
  stopProject(id) {
    if (this.current?.projectId === id) this.current.abort.abort();
  }

  addActivity(projectId, item) {
    const row = { t: now(), ...item, text: String(item.text || '').slice(0, 2000) };
    const list = this.activity.get(projectId) || [];
    list.push(row);
    if (list.length > 300) list.splice(0, list.length - 300);
    this.activity.set(projectId, list);
    if (this.current?.activityFile) appendFileSync(this.current.activityFile, JSON.stringify(row) + '\n');
    this.emit('activity', { project: projectId, ...row });
  }

  async runSession(projectId) {
    const root = this.root;
    const config = loadConfig(root);
    // A project can pin its own backend (the demo project does); otherwise the studio's setting.
    const backendName = loadProject(root, projectId).backend || config.backend;
    config.backend = backendName;
    const backend = BACKENDS[backendName];
    if (!backend) throw new Error(`unknown backend "${backendName}" (claude-code, anthropic-api or demo)`);
    const pp = projectPaths(root, projectId);
    const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    const transcript = join(pp.sessions, `${sessionId}.jsonl`);
    const abort = new AbortController();
    this.current = { projectId, sessionId, abort, activityFile: join(pp.sessions, `${sessionId}.activity.jsonl`) };
    const startedAt = Date.now();
    const eventsBefore = readEvents(root, projectId, { limit: 100000 }).length;

    update(root, projectId, (p) => { p.session = { running: true, id: sessionId, backend: config.backend, started_at: now() }; });
    const reason = sessionReason(root, projectId);
    event(root, projectId, { event: 'SESSION_STARTED', details: `${config.backend}: ${reason}` });
    this.emit('change');
    this.log(`▶ ${projectId}: ${reason}`);

    let bridge;
    let result;
    const timer = setTimeout(() => { this.addActivity(projectId, { kind: 'info', text: `Session time limit (${config.maxSessionMinutes} min) reached: stopping.` }); abort.abort(); }, config.maxSessionMinutes * 60_000);
    try {
      prepareWorkdir(root, projectId);
      mkdirSync(join(paths(root).run, 'shared'), { recursive: true });
      writeTorch(root, projectId, { backend: config.backend, reason });
      const sessionEnv = readSessionEnv(root);
      bridge = await openBridge({ root, projectId, sessionId, workdir: pp.work, renders: this.renders, sessionEnv });
      this.addActivity(projectId, { kind: 'info', text: `Session started (${config.backend}). ${reason}` });
      result = await backend.run({
        root,
        projectId,
        workdir: pp.work,
        prompt: `Read ./CLAUDE.md fully and follow it. Resume this project from checklist.md, JOURNAL.md and feedback/. Why this session started: ${reason}`,
        env: { ...sessionEnv, ...bridge.env, MFX_SHARED: join(paths(root).run, 'shared') },
        transcript,
        onActivity: (a) => this.addActivity(projectId, a),
        signal: abort.signal,
        config,
      });
    } catch (e) {
      result = { ok: false, error: e.message };
    } finally {
      clearTimeout(timer);
      this.renders.stopSession(sessionId);
      await bridge?.close();
    }

    const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
    const newEvents = readEvents(root, projectId, { limit: 100000 }).slice(eventsBefore).filter((e) => e.actor === 'studio');
    const progressed = newEvents.some((e) => PROGRESS.includes(e.event));
    const gated = newEvents.some((e) => GATE_PROGRESS.includes(e.event));
    const pipeline = projectPipeline(root, projectId);
    let pausedFor = null;
    update(root, projectId, (p) => {
      p.session = null;
      p.usage.sessions += 1;
      p.usage.input_tokens += result?.usage?.input_tokens || 0;
      p.usage.output_tokens += result?.usage?.output_tokens || 0;
      if (result?.cost_usd) p.usage.cost_usd = Math.round(((p.usage.cost_usd || 0) + result.cost_usd) * 10000) / 10000;
      p.no_progress = progressed ? 0 : (p.no_progress || 0) + 1;
      p.without_gate = gated ? 0 : (p.without_gate || 0) + 1;
      if (p.status?.key === '_render') p.status = null;
      settle(p, pipeline);
      if (p.state === 'queued' && !abort.signal.aborted) {
        if (p.no_progress >= 2) pausedFor = `The last two sessions stopped without moving the project forward${result?.error ? ` (${result.error})` : ''}. Check the activity log, then resume.`;
        else if (p.without_gate >= MAX_SESSIONS_WITHOUT_GATE) pausedFor = `${MAX_SESSIONS_WITHOUT_GATE} sessions in a row ended without submitting or finishing a step. Check the journal, then resume.`;
        if (pausedFor) { p.state = 'paused'; p.needs_you = { text: pausedFor, at: now() }; }
      }
    });
    event(root, projectId, { event: 'SESSION_ENDED', details: `${result?.ok ? 'ok' : `error: ${result?.error}`} · ${minutes} min` });
    if (pausedFor) event(root, projectId, { event: 'NEEDS_YOU', details: pausedFor });
    this.addActivity(projectId, { kind: result?.ok ? 'info' : 'error', text: result?.ok ? `Session ended (${minutes} min).` : `Session ended: ${result?.error}` });
    this.log(`■ ${projectId}: ${result?.ok ? 'ok' : result?.error} (${minutes} min) → ${loadProject(root, projectId).state}`);
    this.current = null;
    this.emit('change');
    return result;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
