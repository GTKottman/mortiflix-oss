// The studio's render queue: as many heavy renders at once as the machine can take (owner, 2026-11-02: "If you have the
// space for renders, you better use the space for renders"), never more. Sessions queue with `mfx render` and poll with
// `mfx render-wait`, so no tool call ever blocks longer than its timeout.
//
// How many run at once (config.json renders.parallel: a number, or "auto", the default). Auto is re-decided every time a
// render could start (one ends, one is added, every sweep), so it backs off when memory runs low:
//   CPU     threads / threads per render. A Kinetograph render draws frames in worker threads, by default half the cores
//           and at most 4 (renderThreads(), the same rule as Kinetograph's own default and the animatic's --concurrency 4),
//           so 4 renders of 4 workers fill a 16-thread machine without oversubscribing it.
//   memory  floor(0.7 x available RAM / peak RAM of one render). The peak is MEASURED: the RSS of each render's whole process
//           tree (its process group: the engine, ffmpeg and all), sampled while it runs, kept per kind of render (the last 5
//           peaks, the highest counts) in <logDir>/peaks.json. Until a kind has been measured, SEED_PEAK is used: Kinetograph
//           takes 0.5 to 1 GB a worker (its render.ts), so 4 workers + the Node host + the encoder is at most about 4.5 GB.
//           A render already running is counted at its kind's peak (it may still grow to it), not at what it uses now.
//   never   start a second render when less than MIN_FREE (4 GB) is available. The first render always starts.
// Fair: a waiting render of a project with fewer renders running goes first, then the project whose last render started
// longest ago, then the oldest; one project's batch never starves another's.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { availableParallelism, freemem } from 'node:os';
import { join } from 'node:path';
import { command, groupOptions, killTreeHard, pidAlive } from './platform.mjs';

const GB = 1024 ** 3;
export const SEED_PEAK = 4.5 * GB;
export const MIN_FREE = 4 * GB;
const MIN_PEAK = 0.5 * GB; // a measured peak below this is not trusted (a wrapper that hands the work to another process)
const KEEP_PEAKS = 5;

// Frames one render draws at once: Kinetograph's own default (packages/cli/src/commands/render.ts defaultConcurrency).
export const renderThreads = (cpus = availableParallelism()) => Math.min(4, Math.max(1, Math.floor(cpus / 2)));

/** How many renders fit at once: min(CPU slots, floor(0.7 x available / peak)), at least 1. Bytes. */
export function autoSlots({ cpus = availableParallelism(), threads = renderThreads(cpus), available = freemem(), peak = SEED_PEAK } = {}) {
  const cpu = Math.max(1, Math.floor(cpus / threads));
  return Math.max(1, Math.min(cpu, Math.floor((0.7 * available) / Math.max(MIN_PEAK, peak))));
}

// One kind per sort of render, for its measured peak: the label without numbers and counts ("style frames (3)" and
// "style frames (5)" are one kind). App renders: app:<kind>.
export const renderKind = (label) => String(label || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[\d#:./-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'render';

// Linux: every process's parent, group and RSS, from /proc (one pass, a few ms). Null elsewhere (no measuring: the seed
// and the learned peaks still decide).
const PAGE = 4096; // x86-64 and arm64 Linux's page size
export function procTable() {
  let names;
  try { names = readdirSync('/proc'); } catch { return null; }
  const rows = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let s;
    try { s = readFileSync(`/proc/${n}/stat`, 'utf8'); } catch { continue; }
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    rows.push({ pid: Number(n), ppid: Number(f[1]), pgrp: Number(f[2]), rss: Number(f[21]) * PAGE });
  }
  return rows;
}

/** RSS of a process tree: `pid`, everything below it, and every member of process group `group`. Bytes. */
export function treeRss(rows, { pid, group = null }) {
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set();
  const stack = [pid, ...(group ? rows.filter((r) => r.pgrp === group).map((r) => r.pid) : [])];
  let sum = 0;
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    if (byPid.has(p)) sum += byPid.get(p).rss;
    for (const k of kids.get(p) || []) stack.push(k.pid);
  }
  return sum;
}

// Is this process (or, with a negative pid, this process group) still alive? (one copy, in platform.mjs)
export { pidAlive };

// A job only ever shows 'running' while something is really running: reconcile() looks at the process and settles a job
// whose process is gone from its real exit code. A live process is never failed for being quiet (no idle timeout anywhere).
// parallel: 'auto' (default), a number, or a function returning either (read on every decision: the runner passes
// config.json's renders.parallel). cpus, mem (available bytes) and table (procTable) are for tests.
export class RenderQueue {
  constructor({ logDir, onChange = () => {}, sweepMs = 5000, graceMs = 1000, parallel = 'auto', cpus = availableParallelism, mem = freemem, table = procTable, sampleMs = 2000 }) {
    this.graceMs = graceMs;
    if (sweepMs) { this.sweeper = setInterval(() => this.pump(), sweepMs); this.sweeper.unref?.(); }
    this.logDir = logDir;
    this.onChange = onChange;
    this.parallel = parallel;
    this.cpus = cpus;
    this.mem = mem;
    this.table = table;
    this.sampleMs = sampleMs;
    this.jobs = new Map();
    this.order = [];
    this.next = 1;
    this.starts = 0;
    this.lastStart = new Map(); // project -> start number of its newest render (fairness)
    this.peaks = this.loadPeaks();
  }

  get peakFile() { return join(this.logDir, 'peaks.json'); }
  loadPeaks() { try { const p = JSON.parse(readFileSync(this.peakFile, 'utf8')); return p && typeof p === 'object' ? p : {}; } catch { return {}; } }

  // The RAM one render of this kind is expected to reach: the highest of its last measured peaks, else the seed.
  peakOf(kind) {
    const l = this.peaks[kind];
    return Array.isArray(l) && l.length ? Math.max(MIN_PEAK, ...l) : SEED_PEAK;
  }

  record(job) {
    if (!(job.peakRss >= MIN_PEAK)) return;
    this.peaks[job.kindKey] = [...(this.peaks[job.kindKey] || []), job.peakRss].slice(-KEEP_PEAKS);
    try { mkdirSync(this.logDir, { recursive: true }); writeFileSync(this.peakFile, `${JSON.stringify(this.peaks, null, 1)}\n`); } catch { /* kept in memory */ }
  }

  setting() {
    const v = typeof this.parallel === 'function' ? this.parallel() : this.parallel;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : 'auto';
  }

  /** How many renders the queue would run at once right now with nothing running (for status and the report). */
  slots() {
    const set = this.setting();
    if (set !== 'auto') return set;
    // The biggest kind measured so far (the seed until one is).
    const known = Object.keys(this.peaks).map((k) => this.peakOf(k));
    const peak = known.length ? Math.max(...known) : SEED_PEAK;
    return autoSlots({ cpus: this.cpus(), available: this.mem(), peak });
  }

  // Whether `job` may start now, with `running` already running: null = yes, else why not ('slot' | 'memory').
  blocker(job, running) {
    if (!running.length) return null;
    const set = this.setting();
    const cpus = this.cpus();
    const limit = set === 'auto' ? Math.max(1, Math.floor(cpus / renderThreads(cpus))) : set;
    if (running.length >= limit) return 'slot';
    // A running render may still grow to its kind's peak: that part of the memory is spoken for.
    const reserve = running.reduce((a, j) => a + Math.max(0, this.peakOf(j.kindKey) - (j.rss || 0)), 0);
    const free = this.mem() - reserve;
    if (free < MIN_FREE) return 'memory';
    if (set === 'auto' && 0.7 * free < this.peakOf(job.kindKey)) return 'memory';
    return null;
  }

  // The fair order the waiting renders would start in.
  startOrder() {
    const runningBy = new Map();
    for (const j of this.jobs.values()) if (j.state === 'running') runningBy.set(j.projectId, (runningBy.get(j.projectId) || 0) + 1);
    const last = new Map(this.lastStart);
    let n = this.starts;
    const waiting = this.order.map((i) => this.jobs.get(i)).filter((j) => j.state === 'waiting');
    const out = [];
    while (waiting.length) {
      let best = 0;
      const key = (j) => [runningBy.get(j.projectId) || 0, last.get(j.projectId) || 0];
      for (let i = 1; i < waiting.length; i++) {
        const [a1, a2] = key(waiting[i]), [b1, b2] = key(waiting[best]);
        if (a1 < b1 || (a1 === b1 && a2 < b2)) best = i;
      }
      const j = waiting.splice(best, 1)[0];
      out.push(j);
      runningBy.set(j.projectId, (runningBy.get(j.projectId) || 0) + 1);
      last.set(j.projectId, ++n);
    }
    return out;
  }

  // Sample the RSS of every running render's process tree (Linux), keeping each one's peak.
  sample() {
    const running = [...this.jobs.values()].filter((j) => j.state === 'running');
    if (!running.length) { clearInterval(this.sampler); this.sampler = null; return; }
    const rows = this.table();
    if (!rows) return;
    for (const j of running) {
      const pid = j.external ? j.pid : j.proc?.pid;
      if (!Number.isInteger(pid)) continue;
      j.rss = treeRss(rows, { pid, group: j.external ? null : pid });
      j.peakRss = Math.max(j.peakRss || 0, j.rss);
    }
  }

  add({ projectId, sessionId, label, argv, cwd, env, kind = null }) {
    if (!Array.isArray(argv) || !argv.length) throw new Error('nothing to render: mfx render --label "..." -- <command>');
    const id = this.next++;
    mkdirSync(this.logDir, { recursive: true });
    const job = { id, projectId, sessionId, label: String(label || argv.join(' ')).slice(0, 120), argv, cwd, env, state: 'waiting', log: join(this.logDir, `render-${id}.log`), waiters: [] };
    job.kindKey = kind ? String(kind).slice(0, 40) : renderKind(job.label);
    this.jobs.set(id, job);
    this.order.push(id);
    this.pump();
    return this.view(job);
  }

  // A render the desktop app runs itself (a Mortiflix Studio export): it takes its turn in the same queue, so two heavy renders
  // never run at once. The app starts when the job turns 'running', reports progress, and says when it finished.
  addExternal({ projectId = null, label, kind = 'export', pid = null }) {
    const id = this.next++;
    const job = { pid: Number.isInteger(Number(pid)) && Number(pid) > 0 ? Number(pid) : null, id, projectId, sessionId: null, label: String(label || 'Export').slice(0, 120), kind: String(kind).slice(0, 40), external: true, state: 'waiting', log: join(this.logDir, `render-${id}.log`), waiters: [] };
    job.kindKey = `app:${job.kind}`;
    this.jobs.set(id, job);
    this.order.push(id);
    this.pump();
    if (job.state === 'waiting') this.onChange(job);
    return this.view(job);
  }

  external(id) {
    const job = this.jobs.get(Number(id));
    if (!job || !job.external) throw new Error(`no app render ${id}`);
    return job;
  }

  report(id, { done = null, total = null, phase = 'rendering', pid = null } = {}) {
    const job = this.external(id);
    if (Number.isInteger(Number(pid)) && Number(pid) > 0) job.pid = Number(pid);
    if (job.state !== 'running') throw new Error(`render ${id} is ${job.state}`);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) job.progress = { phase: String(phase).slice(0, 40), done: Math.max(0, Math.min(done, total)), total };
    if (Date.now() - (job.shownAt || 0) > 250) { job.shownAt = Date.now(); this.onChange(job); }
    return this.view(job);
  }

  finish(id, { ok, file = null, error = null } = {}) {
    const job = this.external(id);
    if (!['running', 'waiting'].includes(job.state)) throw new Error(`render ${id} is already ${job.state}`);
    job.state = ok ? 'done' : 'failed';
    job.exitCode = ok ? 0 : 1;
    job.file = file ? String(file) : null;
    job.error = error ? String(error).slice(0, 2000) : null;
    job.endedAt = new Date().toISOString();
    this.record(job);
    for (const w of job.waiters.splice(0)) w();
    this.onChange(job);
    this.pump();
    return this.view(job);
  }

  // Stop one render: a waiting one never starts, a running command is stopped, an app render is told to stop.
  cancel(id) {
    const job = this.jobs.get(Number(id));
    if (!job) throw new Error(`no render ${id}`);
    if (!['waiting', 'running'].includes(job.state)) return this.view(job);
    if (job.state === 'running' && job.proc) { job.cancelled = true; killTreeHard(job.proc.pid); return this.view(job); }
    // 'failed' (with cancelled), so every waiter that loops until done or failed stops.
    job.state = 'failed';
    job.cancelled = true;
    job.exitCode = -1;
    job.endedAt = new Date().toISOString();
    for (const w of job.waiters.splice(0)) w();
    this.onChange(job);
    this.pump();
    return this.view(job);
  }

  // Settle every 'running' job whose process is gone. A command job: its process group has no member left (so the render
  // engine and ffmpeg are gone too) -> done/failed from the real exit code. An app render that told us its pid: pid gone ->
  // failed (the app can't report any more). An app render with no pid is only the app's word: it stays as reported.
  reconcile() {
    for (const job of this.jobs.values()) {
      if (job.state !== 'running') continue;
      if (job.external) {
        if (job.pid && !pidAlive(job.pid)) this.finish(job.id, { ok: false, error: 'the app stopped before it finished this render (its process is gone)' });
      } else if (job.proc && job.settle) {
        const pid = job.proc.pid;
        if (!Number.isInteger(pid)) continue; // never spawned: the 'error' event settles it
        if (pidAlive(pid) || pidAlive(-pid)) { job.goneSince = null; continue; }
        // Give the normal 'close' event a moment to flush the last output before settling by hand.
        job.goneSince ||= Date.now();
        if (Date.now() - job.goneSince < this.graceMs) continue;
        const { exitCode, signalCode } = job.proc;
        job.settle(exitCode ?? (signalCode ? 128 : 1), exitCode === null && !signalCode ? new Error('the render process is gone and left no exit code') : null);
      }
    }
  }

  list() {
    this.reconcile();
    return this.order.map((i) => this.view(this.jobs.get(i)));
  }

  // Waiting renders that start before this one (several run at once, so the running ones are not ahead of it: it starts
  // when a slot and the memory for it are free and its turn has come).
  ahead(job) {
    const i = this.startOrder().indexOf(job);
    return i < 0 ? 0 : i;
  }

  view(job) {
    const tail = !job.external && existsSync(job.log) ? readFileSync(job.log, 'utf8').slice(-3000) : '';
    return {
      id: job.id,
      label: job.label,
      state: job.state,
      project: job.projectId ?? null,
      ...(job.external ? { external: true, kind: job.kind } : {}),
      ...(job.file ? { file: job.file } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.cancelled ? { cancelled: true } : {}),
      ...(job.state === 'waiting' ? { renders_ahead: this.ahead(job), renders_running: [...this.jobs.values()].filter((j) => j.state === 'running').length, ...(job.blocked === 'memory' ? { waiting_for: 'memory' } : {}) } : {}),
      ...(job.exitCode !== undefined ? { exit_code: job.exitCode } : {}),
      ...(['done', 'failed'].includes(job.state) && !job.external ? { output_tail: tail } : {}),
      ...(job.state === 'running' && job.progress ? { progress: { ...job.progress,
        ...(job.progress.total ? { percent: Math.round((job.progress.done / job.progress.total) * 100) } : {}),
        // Time left from the rate so far.
        ...(job.progress.total && job.progress.done ? { seconds_left: Math.round(((Date.now() - Date.parse(job.startedAt)) / job.progress.done) * (job.progress.total - job.progress.done) / 1000) } : {}) } } : {}),
      started_at: job.startedAt || null,
      ended_at: job.endedAt || null,
    };
  }

  get(id, projectId) {
    this.reconcile();
    const job = this.jobs.get(Number(id));
    if (!job || job.projectId !== projectId) throw new Error(`no render ${id} in this project`);
    return job;
  }

  // Resolves when the render finishes or after `seconds`, whichever comes first.
  wait(id, projectId, seconds = 100) {
    const job = this.get(id, projectId);
    if (['done', 'failed'].includes(job.state)) return Promise.resolve(this.view(job));
    return new Promise((ok) => {
      const t = setTimeout(() => { job.waiters = job.waiters.filter((w) => w !== done); ok(this.view(job)); }, Math.min(590, Math.max(1, seconds)) * 1000);
      const done = () => { clearTimeout(t); ok(this.view(job)); };
      job.waiters.push(done);
    });
  }

  // Stop one render by its id (`mfx render-stop`): a waiting one never starts; a running one gets SIGTERM on its whole
  // process group (the render engine, ffmpeg and all), then SIGKILL after `graceMs`. Never by name: only the group this queue started.
  stop(id, projectId, graceMs = 5000) {
    const job = this.get(id, projectId);
    if (job.state === 'waiting') {
      job.state = 'failed'; job.exitCode = -1; job.stopped = true;
      for (const w of job.waiters.splice(0)) w();
      this.onChange(job);
      this.pump();
    } else if (job.state === 'running' && job.proc) {
      job.stopped = true;
      killTreeHard(job.proc.pid, { graceMs });
    }
    return this.view(job);
  }

  // Start every waiting render that fits now, in the fair order; the first that doesn't fit stops the round (no
  // overtaking: a small render never jumps a big one that waits for memory).
  pump() {
    this.reconcile();
    for (const j of this.jobs.values()) if (j.state === 'waiting') j.blocked = null;
    for (;;) {
      const job = this.startOrder()[0];
      if (!job) break;
      const running = [...this.jobs.values()].filter((j) => j.state === 'running');
      const why = this.blocker(job, running);
      if (why) { job.blocked = why; break; }
      this.start(job);
    }
    if (!this.sampler && this.sampleMs && [...this.jobs.values()].some((j) => j.state === 'running')) {
      this.sampler = setInterval(() => this.sample(), this.sampleMs);
      this.sampler.unref?.();
    }
  }

  start(job) {
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    this.lastStart.set(job.projectId, ++this.starts);
    if (job.external) { this.onChange(job); return; }
    const out = createWriteStream(job.log);
    // A log that can't be written (disk full, folder gone) loses its text, not the service: an 'error' with no
    // listener would be thrown and end the process. The render itself goes on and settles from its exit code.
    out.on('error', () => { /* the log text is lost; the job still settles (end's callback runs on error too) */ });
    out.write(`$ ${job.argv.join(' ')}\n`);
    // Temp files on disk, next to the logs: /tmp is often RAM (tmpfs), and a long render's frames and pre-encode there
    // eat the memory the render itself needs (a 26 min animatic wrote its pre-encode into a 16 GB tmpfs /tmp).
    const tmp = join(this.logDir, 'tmp', String(job.id));
    try { mkdirSync(tmp, { recursive: true }); } catch { /* falls back to the system temp below */ }
    const env = existsSync(tmp) ? { ...(job.env || process.env), TMPDIR: tmp, TMP: tmp, TEMP: tmp } : job.env;
    const finish = (code, err) => {
      if (job.state !== 'running') return;
      job.exitCode = code;
      job.state = code === 0 ? 'done' : 'failed';
      job.endedAt = new Date().toISOString();
      job.proc = null;
      this.record(job);
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* left for the next clean */ }
      if (err) out.write(`\n${err.message}\n`);
      out.end(() => {
        for (const w of job.waiters.splice(0)) w();
        this.onChange(job);
        this.pump();
      });
    };
    job.settle = finish;
    // npx and npm are .cmd programs on Windows and `bash` is Git Bash there: command() finds them (cmd.exe for .cmd,
    // refusing arguments it can't pass through it safely, which fails the render with the reason). detached on
    // Linux/macOS (the whole group is stopped on cancel); windowsHide on Windows (taskkill /T stops the tree).
    let c;
    try { c = command(job.argv[0], job.argv.slice(1), { env }); } catch (e) { finish(127, e); return; }
    const p = spawn(c.file, c.args, { ...c.options, ...groupOptions(), cwd: job.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = p;
    p.stdout.pipe(out, { end: false });
    p.stderr.pipe(out, { end: false });
    // How far it is, read from the render's own output (Kinetograph's "rendering frame 120/450" on stderr, every tenth
    // of the frames, then "mixing audio"; older renders' "Rendered 120/450", "Encoded …"; ffmpeg's "time=00:00:03.12"),
    // for the owner's live view. Percent and seconds left come from done/total in view(). At most one update a second.
    // Kinetograph only prints this without --json, so render commands queued here leave --json off.
    const watch = (d) => {
      const s = String(d);
      const m = [...s.matchAll(/(rendering frame|Rendered|Encoded|Rendering frames|Stitching)[^\d]{0,12}(\d+)\s*\/\s*(\d+)/g)].pop();
      const t = [...s.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
      if (m) job.progress = { phase: /Encod|Stitch/.test(m[1]) ? 'encoding' : 'rendering', done: Number(m[2]), total: Number(m[3]) };
      else if (/mixing audio/.test(s)) job.progress = { ...(job.progress || {}), phase: 'mixing audio' };
      else if (t) job.progress = { phase: 'encoding', seconds: Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) };
      else return;
      if (Date.now() - (job.shownAt || 0) > 1000) { job.shownAt = Date.now(); this.onChange(job); }
    };
    p.stdout.on('data', watch);
    p.stderr.on('data', watch);
    p.on('error', (e) => finish(127, e));
    p.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
    this.onChange(job);
  }

  // A session ended: its renders stop (a session can't leave work running behind it).
  stopSession(sessionId) {
    for (const job of this.jobs.values()) {
      if (job.sessionId !== sessionId) continue;
      if (job.state === 'waiting') { job.state = 'failed'; job.exitCode = -1; for (const w of job.waiters.splice(0)) w(); }
      if (job.state === 'running' && job.proc) killTreeHard(job.proc.pid);
    }
    this.pump();
  }

  activeFor(projectId) {
    this.reconcile();
    return [...this.jobs.values()].filter((j) => j.projectId === projectId && ['waiting', 'running'].includes(j.state)).map((j) => this.view(j));
  }
}
