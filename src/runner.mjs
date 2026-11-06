// The runner: picks the next project that has work, starts one session for it, and repeats. Sessions end at gates,
// so a project waiting on you costs nothing. One session at a time, first in first out.
import { freemem } from 'node:os';
import { mayStartSession, loadPeak, recordPeak } from './svc/sessionslots.mjs';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, paths, loadConfig, readSessionEnv, DEFAULT_CONFIG } from './studio.mjs';
import { killTreeHard, pidAlive, procStart } from './platform.mjs';
import { sessionVoiceEnv } from './voice/index.mjs';
import { sessionToolsEnv, ensureBrowser } from './setup.mjs';
import { loadEdits } from './canvas.mjs';
import { listProjects, loadProject, projectPaths, projectPipeline, update, event, readEvents, now } from './projects.mjs';
import { settle, needsYou } from './gates.mjs';
import { projectMissingKeys, missingKeysText } from './keys.mjs';
import { prepareWorkdir, writeTorch, sessionReason } from './torch.mjs';
import { makeFallback } from './svc/giveup.mjs';
import { routeOpenEdits } from './svc/editroutes.mjs';
import { failureSignature, fixText, HARD } from './svc/failures.mjs';
import { loadTheme } from './svc/theme.mjs';
import { runUsage } from './svc/tokens.mjs';
import { openBridge } from './bridge.mjs';
import { sentLog } from './svc/sentlog.mjs';
import { quickScriptStep, quickScript, quickBriefStep, quickBrief } from './quickscript.mjs';
import { quickVoiceStep, quickVoice } from './quickvoice.mjs';
import { quickFramesStep, quickFrames } from './quickframes.mjs';
import { quickTransitionsStep, quickTransitions } from './quicktransitions.mjs';
import { quickAnimaticStep, quickAnimatic } from './quickanimatic.mjs';
import { quickSceneStep, quickScene } from './quickscene.mjs';
import { quickMusicStep, quickMusic } from './quickmusic.mjs';
import { quickV3Step, V3_RUN, planMusicAfterVoice } from './quickv3.mjs';
import { RenderQueue } from './renderq.mjs';
import * as claudeCode from './backends/claude-code.mjs';
import * as anthropicApi from './backends/anthropic-api.mjs';
import * as demo from './backends/demo.mjs';
import * as replay from './backends/replay.mjs';
import { replayOn, replayStudio } from './replay.mjs';
import { restartMotion, startAhead } from './svc/stages.mjs';
import { sceneRemaking } from './svc/lessons.mjs';
import { bookSession, currentStage, ledgerFile } from './svc/ledger.mjs';
import { paidGate, waitForCost } from './svc/paidgate.mjs';

export const BACKENDS = { 'claude-code': claudeCode, 'anthropic-api': anthropicApi, demo, replay };
const PROGRESS = ['SUBMITTED', 'STEP_DONE', 'ASKED', 'NEEDS_YOU', 'HANDOFF'];
const GATE_PROGRESS = ['SUBMITTED', 'STEP_DONE', 'ASKED', 'NEEDS_YOU'];
const MAX_SESSIONS_WITHOUT_GATE = 8;

// A session that ended because Claude Code isn't signed in ("OAuth session expired", "401", "Please run /login").
export const loginTrouble = (error) => /oauth|authenticat|\b401\b|\/login|not logged in|logged out|signed out|unauthori[sz]ed|invalid api key|credentials? (?:expired|invalid)|session expired|token expired/i.test(String(error || ''));

// What every session opened first, one tool call each (ls, cat checklist, JOURNAL, feedback, PIPELINE.md, GATES.md,
// SKILLS.md): handed over in the prompt instead, so the session starts working on its first step, not on step six
// with all of them re-read on every step after. Long journals and feedback keep their newest part.
const START_FILES = [
  ['CLAUDE.md', 'CLAUDE.md', 0],
  ['SKILLS.md', 'SKILLS.md', 0],
  ['pipeline/PIPELINE.md', 'pipeline/PIPELINE.md', 0],
  ['.mortiflix/GATES.md', '.mortiflix/GATES.md', 0],
  ['checklist.md', 'checklist.md', 0],
  ['JOURNAL.md', 'JOURNAL.md (newest part)', 12_000],
];
const FEEDBACK_MAX = 20_000;

// claudeMd: false for Claude Code, which loads the project's CLAUDE.md itself (a copy here would be read twice, about 5.5k tokens a call).
export function startPrompt(work, reason, { claudeMd = true } = {}) {
  const parts = [];
  const add = (label, text, max) => {
    const body = max && text.length > max ? `…\n${text.slice(-max)}` : text;
    parts.push(`<file path="${label}">\n${body.trim()}\n</file>`);
  };
  for (const [file, label, max] of START_FILES) {
    if (file === 'CLAUDE.md' && !claudeMd) continue;
    const f = join(work, file);
    if (existsSync(f)) add(label, readFileSync(f, 'utf8'), max);
  }
  const fb = join(work, 'feedback');
  if (existsSync(fb)) {
    let left = FEEDBACK_MAX;
    const files = readdirSync(fb).filter((n) => statSync(join(fb, n)).isFile())
      .sort((a, b) => statSync(join(fb, b)).mtimeMs - statSync(join(fb, a)).mtimeMs);
    for (const n of files) {
      const text = readFileSync(join(fb, n), 'utf8');
      if (text.length > left) { parts.push(`(older feedback files not included: open feedback/ if you need them)`); break; }
      left -= text.length;
      add(`feedback/${n}`, text, 0);
    }
  }
  return [
    `These are this project's start files as they are right now: ${claudeMd ? 'CLAUDE.md (follow it), ' : ''}SKILLS.md, the pipeline, the gate protocol, the checklist, the journal and the feedback. Don't open them again: start on the work. Open any other file as usual.`,
    ...parts,
    `Resume this project from the checklist, the journal and the feedback above. Why this session started: ${reason}`,
  ].join('\n\n');
}

export class Runner extends EventEmitter {
  constructor(root, { log = () => {}, studio = null } = {}) {
    super();
    // replay mode: the recorded stills and music plan stand in for Kinetograph and Claude (src/replay.mjs)
    if (!studio && replayOn()) studio = replayStudio(root);
    this.studio = studio; // injected parts of the v3 studio steps (renderStill, ask, runChecks, writeArtcraft, mixSounds): tests
    this.root = root;
    this.log = log;
    this.running = new Map(); // project id -> its session { projectId, sessionId, abort, activityFile } (one per project)
    this.activity = new Map(); // project id -> recent activity lines
    // renders.parallel in config.json: how many renders at once ("auto", the default, fits them to the CPU and free RAM).
    const parallel = () => { try { return loadConfig(root).renders?.parallel ?? 'auto'; } catch { return 'auto'; } };
    this.renders = new RenderQueue({ logDir: join(paths(root).run, 'renders'), onChange: () => this.emit('change'), parallel });
  }

  // Only one runner per studio (the web server and `mortiflix run` would otherwise start two sessions at once).
  acquire() {
    const lock = join(paths(this.root).run, 'runner.pid');
    mkdirSync(paths(this.root).run, { recursive: true });
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (pid && pid !== process.pid && pidAlive(pid)) throw new Error(`another Mortiflix runner (pid ${pid}) is already running this studio`);
    }
    writeFileSync(lock, String(process.pid));
    this.lockFile = lock;
    // Sessions that were running when the last runner died are over: say so in their log.
    // A planned restart (the app closed our input, or service.restart) wrote which sessions it stopped: those go on by
    // themselves (Dir2, 2026-11-02: every restart left the project "Press Resume"); only a crash or an unknown stop
    // pauses for the owner.
    const planned = takeRestartMark(this.root);
    for (const p of listProjects(this.root)) {
      // the last runner's session may still be running (it crashed, or its stop ran out of time): stop it first, so
      // two sessions never work in the same folder
      if (p.session?.running) stopOrphan(p.session, (l) => this.log(`${p.id}: ${l}`));
      if (planned.includes(p.id) && (p.session?.running || p.state === 'queued' || p.needs_you?.cause === 'restart')) {
        update(this.root, p.id, (x) => {
          x.session = null;
          if (['queued', 'paused'].includes(x.state) && (!x.needs_you || ['stopped', 'restart'].includes(x.needs_you.cause))) { x.state = 'queued'; x.needs_you = null; x.queued_at ||= now(); }
        });
        event(this.root, p.id, { event: 'RESUMED', actor: 'studio', details: 'Restarted the studio; picked up again' });
        continue;
      }
      if (p.session?.running) {
        // T3: stopped is stopped: it waits for Resume instead of starting again with "Carrying on"
        update(this.root, p.id, (x) => {
          x.session = null;
          if (x.state === 'queued') { x.state = 'paused'; x.needs_you = { text: 'The studio was stopped while this was running. Press Resume to carry on.', at: now(), cause: 'stopped' }; }
        });
        event(this.root, p.id, { event: 'SESSION_ENDED', details: 'interrupted (the studio was stopped)' });
      }
    }
  }

  release() {
    if (this.lockFile && existsSync(this.lockFile) && readFileSync(this.lockFile, 'utf8') === String(process.pid)) rmSync(this.lockFile);
  }

  // The first session running (older callers knew one session at a time).
  get current() { return this.running.values().next().value || null; }

  // Queued projects with no session, oldest first.
  queue() {
    return listProjects(this.root)
      .filter((p) => p.state === 'queued' && !this.running.has(p.id))
      .sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
  }

  next() { return this.queue()[0] || null; }

  // Sessions at once (svc/sessionslots.mjs): config sessions.parallel, "auto" by free RAM; `mem` is for tests.
  slotsNow(mem = this.mem || freemem) {
    let setting = 'auto';
    try { setting = loadConfig(this.root).sessions?.parallel ?? 'auto'; } catch { /* auto */ }
    return { setting, available: mem(), peak: loadPeak(this.peakFile) };
  }
  get peakFile() { return join(paths(this.root).run, 'session-peaks.json'); }

  // Run sessions until nothing is runnable, as many at once as sessions.parallel allows (one per project). With
  // `watch`, keep looking for new work until stopped.
  async loop({ watch = false, pollMs = 1500 } = {}) {
    this.stopping = false;
    const going = new Map();
    while (!this.stopping) {
      for (const p of this.queue()) {
        if (going.has(p.id) || this.stopping || this.draining) continue;
        if (mayStartSession({ running: going.size, ...this.slotsNow() })) break;
        const run = this.runSession(p.id).catch((e) => { this.log(`✖ ${p.id}: ${e.message}`); this.pauseFailed(p.id, e); }).finally(() => { going.delete(p.id); this.running.delete(p.id); this.wake(); });
        going.set(p.id, run);
        // the session marks itself running before its first await; a project that returned at once (a key, the cost) is done
        await Promise.resolve();
      }
      if (!going.size && !watch && !this.next()) break;
      if (!going.size && !watch) continue;
      await new Promise((ok) => { this.poke = ok; setTimeout(ok, pollMs); });
      this.poke = null;
    }
    await Promise.allSettled([...going.values()]);
  }

  wake() { this.poke?.(); }

  // A confirmed New take / new words is made at once, with no session and without waiting for the runner: it waited
  // 4.4 min behind another project's session on 2026-11-02 (Dir3, lines sat at "Making"). Only the code routes that
  // need no AI call; the runner's own route (before a session) takes the rest. Routes of one project run one at a time.
  async routeTakes(projectId) {
    const root = this.root;
    const routed = await routeOpenEdits({ root, id: projectId, only: ['retake', 'words'], onActivity: (a) => this.addActivity(projectId, a), env: process.env, deps: this.studio?.editDeps || {} });
    if (!routed.handled.length) return routed;
    this.addActivity(projectId, { kind: 'info', text: `Done by the studio, no session: ${routed.handled.join(', ')}.` });
    const done = loadEdits(root, projectId).filter((e) => routed.handled.includes(e.id)).map((e) => e.node);
    this.emit('nodes', { project: projectId, nodes: [...new Set(done)] });
    update(root, projectId, (p) => { p.canvas_edits = loadEdits(root, projectId).filter((e) => ['requested', 'working'].includes(e.state)).length; settle(p, projectPipeline(root, projectId)); });
    this.emit('change');
    return routed;
  }

  // restart: a planned restart (the sessions it stops are picked up again by the next runner, see acquire)
  async stop({ restart = false } = {}) {
    if (restart) { this.restarting = true; markRestart(this.root, [...this.running.keys()]); }
    this.stopping = true;
    for (const r of this.running.values()) r.abort.abort();
    this.wake();
    // A stopped session is SIGKILLed after 5 s and its pipes closed after 10 s (backends/claude-code.mjs); never wait
    // forever: what is still running after this goes to the log, and the next runner stops it (stopOrphan).
    const until = Date.now() + STOP_WAIT_MS;
    while (this.running.size && Date.now() < until) await new Promise((ok) => setTimeout(ok, 100));
    if (this.running.size) this.log(`stopping: ${[...this.running.keys()].join(', ')} did not end within ${STOP_WAIT_MS / 1000} s`);
  }

  // Stop the session working on one project (pause / cancel from the UI).
  stopProject(id) {
    const r = this.running.get(id);
    if (!r) return;
    r.byOwner = true; // the owner's Pause/Cancel set the state themselves (see the end of runSession)
    r.abort.abort();
  }

  // runSession threw (a damaged record, a check that failed): the project would stay queued and be tried again every
  // 1.5 s, forever and silently. It pauses with the reason instead.
  pauseFailed(projectId, e) {
    try {
      let paused = null;
      update(this.root, projectId, (p) => {
        p.session = null; // whatever it got to, this run is over
        if (p.state !== 'queued') return;
        p.state = 'paused';
        p.needs_you = { text: `The studio couldn't run this project: ${String(e?.message || e).slice(0, 300)}. Fix that, then press Resume.`, at: now(), cause: 'error' };
        paused = p.needs_you.text;
      });
      if (paused) event(this.root, projectId, { event: 'NEEDS_YOU', details: paused });
    } catch (err) { this.log(`✖ ${projectId}: could not pause it either (${err.message})`); }
    this.emit('change');
  }

  addActivity(projectId, item) {
    const row = { t: now(), ...item, text: String(item.text || '').slice(0, 2000) };
    const list = this.activity.get(projectId) || [];
    list.push(row);
    if (list.length > 300) list.splice(0, list.length - 300);
    this.activity.set(projectId, list);
    const run = this.running.get(projectId);
    // inside the session's output handler: a write that fails (disk full) must not throw out of it and end the service
    if (run?.activityFile) { try { appendFileSync(run.activityFile, JSON.stringify(row) + '\n'); } catch { /* the live view keeps the row */ } }
    this.emit('activity', { project: projectId, ...row });
  }

  async runSession(projectId) {
    const root = this.root;
    // A key the next steps need is missing: ask for it now, rather than let a session fail halfway through.
    const missing = projectMissingKeys(root, projectId, { upcoming: true });
    if (missing.length) {
      needsYou(root, projectId, missingKeysText(missing));
      this.log(`‖ ${projectId}: needs a key (${missing.join(', ')})`);
      this.emit('change');
      return;
    }
    const config = loadConfig(root);
    // A project can pin its own backend (the demo project does); otherwise the studio's setting.
    // replay mode: every project runs on the recordings, whatever backend it pinned
    const backendName = replayOn() ? 'replay' : (loadProject(root, projectId).backend || config.backend);
    // Cost first (src/svc/paidgate.mjs): a step that spends ElevenLabs never starts by itself. The project waits for the
    // owner's OK on the cost (and, for the voice, the voice), then step.confirm_cost queues it again.
    const quickSteps = [quickV3Step(root, projectId, config), backendName === 'claude-code' ? quickMusicStep(root, projectId, config) : null].filter(Boolean).map((v) => v.key);
    const costGate = paidGate(root, projectId, { backend: backendName, quickSteps });
    if (costGate) {
      waitForCost(root, projectId, costGate);
      this.log(`‖ ${projectId}: waiting for the OK on the cost (${costGate.step}, about ${costGate.estimate_credits ?? '?'} credits)`);
      this.emit('change');
      return { ok: false, paused: true, cost_ok: costGate };
    }
    config.backend = backendName;
    const backend = BACKENDS[backendName];
    if (!backend) throw new Error(`unknown backend "${backendName}" (claude-code, anthropic-api or demo)`);
    const pp = projectPaths(root, projectId);
    const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    const transcript = join(pp.sessions, `${sessionId}.jsonl`);
    const abort = new AbortController();
    const me = { projectId, sessionId, abort, activityFile: join(pp.sessions, `${sessionId}.activity.jsonl`) };
    this.running.set(projectId, me);
    // the RAM one session takes, measured while it runs alone (free RAM at the start less the lowest seen): auto slots
    const freeAtStart = freemem(); let lowest = freeAtStart;
    const alone = () => this.running.size === 1;
    const peakTimer = setInterval(() => { if (alone()) lowest = Math.min(lowest, freemem()); else lowest = -1; }, 5000);
    peakTimer.unref?.();
    const startedAt = Date.now();
    const ledgerStage = currentStage(root, projectId);
    const eventsBefore = readEvents(root, projectId, { limit: 100000 }).length;

    const prevSig = loadProject(root, projectId).last_failure?.sig || null;
    update(root, projectId, (p) => { p.session = { running: true, id: sessionId, backend: config.backend, started_at: now() }; });
    const reason = sessionReason(root, projectId);
    event(root, projectId, { event: 'SESSION_STARTED', details: `${config.backend}: ${reason}` });
    this.emit('change');
    this.log(`▶ ${projectId}: ${reason}`);

    let bridge;
    let result;
    let pausedByEdits = null;
    // the usage ledger books the session as it goes (a crash loses at most the last minute); the end books the rest
    const ledgerTimer = setInterval(() => { bookSession(root, projectId, sessionId, { stage: ledgerStage, backend: backendName }).catch(() => {}); }, 60_000);
    ledgerTimer.unref?.();
    // a limit that is not a positive number (null, 0, "abc" from `mortiflix config`) is the default, never "stop at once"
    const limitMin = Number(config.maxSessionMinutes) > 0 ? Number(config.maxSessionMinutes) : DEFAULT_CONFIG.maxSessionMinutes;
    const timer = setTimeout(() => { this.addActivity(projectId, { kind: 'info', text: `Session time limit (${limitMin} min) reached: stopping.` }); abort.abort(); }, limitMin * 60_000);
    // Token cap (owner requirement 3: "Token blow-ups must be SEEN and STOPPED"): the transcript's fresh tokens (input,
    // cache writes, output; cache reads left out) are read every TOKEN_CHECK_MS, and past config.maxSessionTokens the
    // session is stopped the same way as Pause and the time limit (abort: SIGTERM, then killTreeHard, backends/claude-code.mjs).
    // Not a positive number = the default, never "stop at once", like maxSessionMinutes.
    const tokenCap = Number(config.maxSessionTokens) > 0 ? Number(config.maxSessionTokens) : DEFAULT_MAX_SESSION_TOKENS;
    let tokenChecking = false;
    let sessionEnded = false; // a check still running when the session ends must not stop or pause a finished step
    const tokenTimer = setInterval(() => {
      if (tokenChecking || abort.signal.aborted) return;
      tokenChecking = true;
      runUsage(root, projectId, sessionId).then((u) => {
        const used = u?.fresh_tokens || 0;
        if (sessionEnded || used <= tokenCap || abort.signal.aborted) return;
        me.overCap = `This step used ${used.toLocaleString('en')} tokens, over the cap of ${tokenCap.toLocaleString('en')}; it was stopped so it can't burn your plan.`;
        this.addActivity(projectId, { kind: 'error', text: me.overCap });
        abort.abort();
      }).finally(() => { tokenChecking = false; });
    }, TOKEN_CHECK_MS);
    tokenTimer.unref?.();
    try {
      prepareWorkdir(root, projectId);
      mkdirSync(join(paths(root).run, 'shared'), { recursive: true });
      writeTorch(root, projectId, { backend: config.backend, reason });
      // Keys and settings for the session: session.env, the studio's voice (its key only if it narrates with it), and the
      // tools setup installed (Strudel, Chrome, the studio's Blender) with the owner's music and asset choices.
      const sessionEnv = { ...readSessionEnv(root), ...sessionVoiceEnv(root), ...sessionToolsEnv(root), MFX_HOME: REPO, MFX_LEDGER: ledgerFile(root) };
      // The studio browser: up before the session (started if it can be), and this session's own browser-harness name.
      if (sessionEnv.BU_CDP_URL) {
        const b = await ensureBrowser(root);
        if (b.started) this.addActivity(projectId, { kind: 'info', text: `Started the studio browser (${b.detail}).` });
        else if (!b.ok) this.addActivity(projectId, { kind: 'info', text: `The studio browser isn't answering (${b.detail}): the session works without it.` });
        sessionEnv.BU_NAME = `mfx-${projectId.slice(-4)}-${String(sessionId).replace(/[^a-z0-9]/gi, '').slice(-8)}`;
      }
      bridge = await openBridge({ root, projectId, sessionId, workdir: pp.work, renders: this.renders, sessionEnv });
      this.addActivity(projectId, { kind: 'info', text: `Session started (${config.backend}). ${reason}` });
      const runArgs = {
        root,
        projectId,
        workdir: pp.work,
        prompt: startPrompt(pp.work, reason, { claudeMd: config.backend === 'anthropic-api' }),
        env: { ...sessionEnv, ...bridge.env, MFX_SHARED: join(paths(root).run, 'shared') },
        transcript,
        onActivity: (a) => this.addActivity(projectId, a),
        signal: abort.signal,
        config,
        // each Claude process of this session: its pid and start in the record, so a crashed service's next start finds it
        onSpawn: (pid) => { try { update(root, projectId, (p) => { if (p.session?.id === sessionId) p.session = { ...p.session, pid, pid_start: procStart(pid) }; }); } catch { /* the record stays as it was */ } },
      };
      let sentStep = 'edit';
      const sendRun = sentLog(backend.run, { root, id: projectId, step: () => sentStep });
      // T2: canvas edits that code can do (a voice line's new take, new words, a note on a line) are done now, with no
      // session. Whatever is left open goes to the session as before, unless config.editSession is false: then the
      // project pauses with "needs the AI" and the Let the AI take over button.
      const routed = await routeOpenEdits({ root, id: projectId, run: ['claude-code', 'anthropic-api'].includes(backendName) ? sendRun : null, runArgs, config, onActivity: runArgs.onActivity, env: runArgs.env, deps: this.studio?.editDeps || {} });
      if (routed.handled.length) {
        this.addActivity(projectId, { kind: 'info', text: `Done by the studio, no session: ${routed.handled.join(', ')}.` });
        // the screens of THIS project hear it at once (the service's own node watch only follows its one open project:
        // a re-read on another tab's project stayed "Making" until a reload, Dir2)
        const done = loadEdits(root, projectId).filter((e) => routed.handled.includes(e.id)).map((e) => e.node);
        this.emit('nodes', { project: projectId, nodes: [...new Set(done)] });
        update(root, projectId, (p) => { p.canvas_edits = loadEdits(root, projectId).filter((e) => ['requested', 'working'].includes(e.state)).length; settle(p, projectPipeline(root, projectId)); });
      }
      const editsLeft = loadEdits(root, projectId).filter((e) => ['requested', 'working'].includes(e.state));
      if (routed.handled.length && !editsLeft.length && !['queued'].includes(loadProject(root, projectId).state)) {
        result = { ok: true, routed: routed.handled, usage: routed.usage };
      } else if (editsLeft.length && config.editSession === false && !loadProject(root, projectId).mfx?.takeover) {
        pausedByEdits = `${editsLeft.length === 1 ? 'An edit needs' : `${editsLeft.length} edits need`} the AI (${editsLeft.map((e) => `${e.id} ${e.label}`).join(', ').slice(0, 200)}): the studio has no code route for ${editsLeft.length === 1 ? 'it' : 'them'}. Press "Let the AI take over" to have a session do ${editsLeft.length === 1 ? 'it' : 'them'}.`;
        needsYou(root, projectId, pausedByEdits);
        update(root, projectId, (p) => { p.needs_you = { ...p.needs_you, cause: 'needs-ai', takeover: true }; });
        result = { ok: false, paused: true, error: 'edit needs the AI', usage: routed.usage };
      }
      // The script alone is next: one quick call writes it (src/quickscript.mjs), a session only if that can't.
      // The brief alone is next: the same, one call (quickBrief).
      const quick = backendName === 'claude-code';
      const scriptView = quick ? quickScriptStep(root, projectId, config) : null;
      const briefView = quick && !scriptView ? quickBriefStep(root, projectId, config) : null;
      // The voice is the studio's own work (quickvoice.mjs): no session, an AI call only to re-spell a failing line.
      const voiceView = quick && !scriptView && !briefView ? quickVoiceStep(root, projectId, config) : null;
      // The style frames, driven by the studio: fresh small calls, the studio renders and shows one contact sheet.
      const framesView = quick && !scriptView && !briefView && !voiceView ? quickFramesStep(root, projectId, config) : null;
      // The transition board, the same way: the catalog and one sheet in, the studio renders and checks the board.
      const cutsView = quick && !scriptView && !briefView && !voiceView && !framesView ? quickTransitionsStep(root, projectId, config) : null;
      // The animatic, the same way: one call writes the video, the studio renders and runs the QC, fresh reviews.
      const animaticView = quick && !scriptView && !briefView && !voiceView && !framesView && !cutsView ? quickAnimaticStep(root, projectId, config) : null;
      // One new scene of a scene-by-scene Motion step, the same way (a remake from notes stays a session).
      const sceneView = quick && !scriptView && !briefView && !voiceView && !framesView && !cutsView && !animaticView ? quickSceneStep(root, projectId, config) : null;
      // The music, the same way: one call plans it, code writes the notes, the engine checks, the studio mixes it.
      const musicView = quick && !scriptView && !briefView && !voiceView && !framesView && !cutsView && !animaticView && !sceneView ? quickMusicStep(root, projectId, config) : null;
      // The v3 steps the studio does alone (stills, sound, artcraft): no Claude, and nothing paid.
      const v3View = (quick || this.studio) && !scriptView && !briefView && !voiceView ? quickV3Step(root, projectId, config) : null;
      // T1: a quick path that gives up pauses the project with the reason (after one small repair call); a full session
      // only on "Let the AI take over" or config.sessionFallback.
      sentStep = v3View?.key || (scriptView && 'script') || (briefView && 'brief') || (voiceView && 'voice') || (framesView && 'frames') || (cutsView && 'transitions') || (animaticView && 'animatic') || (sceneView && 'scene') || (musicView && 'music') || 'session';
      const q = { root, id: projectId, run: sendRun, runArgs, config, onActivity: runArgs.onActivity,
        fallback: makeFallback({ root, id: projectId, run: sendRun, runArgs, config, onActivity: runArgs.onActivity, session: () => sendRun(runArgs), label: 'step' }) };
      if (!result) result = v3View ? await V3_RUN[v3View.key]({ root, id: projectId, view: v3View, studio: this.studio || {}, onActivity: runArgs.onActivity, renders: this.renders, sessionId, ...(quick ? { run: sendRun, runArgs, config, fallback: q.fallback } : {}) })
        : scriptView ? await quickScript({ ...q, view: scriptView })
        : briefView ? await quickBrief({ ...q, view: briefView })
          : voiceView ? await quickVoice({ ...q, view: voiceView })
            : framesView ? await quickFrames({ ...q, view: framesView, renders: this.renders, sessionId })
              : cutsView ? await quickTransitions({ ...q, view: cutsView, renders: this.renders, sessionId })
                : animaticView ? await quickAnimatic({ ...q, view: animaticView, renders: this.renders, sessionId })
                  : sceneView ? await quickScene({ ...q, view: sceneView, renders: this.renders, sessionId })
                  : musicView ? await quickMusic({ ...q, view: musicView, renders: this.renders, sessionId })
          : await sendRun(runArgs);
    } catch (e) {
      result = { ok: false, error: e.message };
    } finally {
      sessionEnded = true;
      clearTimeout(timer);
      clearInterval(tokenTimer);
      clearInterval(ledgerTimer);
      this.renders.stopSession(sessionId);
      await bridge?.close();
    }

    // v3: the music plan follows the voice (plan only: the cues cost credits, the owner confirms in the app)
    try { await planMusicAfterVoice(root, projectId, { studio: this.studio || {}, onActivity: (a) => this.addActivity(projectId, a) }); } catch { /* the plan can be made from the app */ }
    const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
    // Tokens: the transcript is what Claude actually used. `result.usage` is missing when a run was stopped or
    // crashed, and covers only the last process when a run made quick calls first: book the larger of the two.
    const seen = await runUsage(root, projectId, sessionId); // async since C405 (reads the transcript in chunks); never rejects
    // the usage ledger: every Claude process in the transcript (quick calls and the session), by model
    await bookSession(root, projectId, sessionId, { stage: ledgerStage, backend: backendName });
    const usedIn = Math.max(result?.usage?.input_tokens || 0, seen?.input_tokens || 0);
    const usedOut = Math.max(result?.usage?.output_tokens || 0, seen?.output_tokens || 0);
    const newEvents = readEvents(root, projectId, { limit: 100000 }).slice(eventsBefore).filter((e) => e.actor === 'studio');
    const progressed = Boolean(result?.routed?.length) || newEvents.some((e) => PROGRESS.includes(e.event));
    const gated = newEvents.some((e) => GATE_PROGRESS.includes(e.event));
    const pipeline = projectPipeline(root, projectId);
    let pausedFor = null;
    let themesMade = false;
    update(root, projectId, (p) => {
      p.session = null;
      // the themes asked for were this session's to make (made or not, one session only: never a loop); made, they
      // go in the chat as a themes card
      if (p.mfx?.samples_wanted) {
        delete p.mfx.samples_wanted;
        themesMade = true;
      }
      if (p.mfx?.takeover) delete p.mfx.takeover; // one takeover = one run
      p.usage.sessions += 1;
      p.usage.input_tokens += usedIn;
      p.usage.output_tokens += usedOut;
      if (seen?.interrupted) p.usage.interrupted = (p.usage.interrupted || 0) + seen.interrupted;
      if (result?.cost_usd) {
        p.usage.cost_usd = Math.round(((p.usage.cost_usd || 0) + result.cost_usd) * 10000) / 10000;
        // On a Claude plan the reported cost is list price, not a charge: keep that part apart so it's never shown as spend.
        if (result.billing === 'plan') p.usage.plan_usd = Math.round(((p.usage.plan_usd || 0) + result.cost_usd) * 10000) / 10000;
      }
      if (!(abort.signal.aborted && this.restarting)) p.no_progress = progressed ? 0 : (p.no_progress || 0) + 1;
      p.without_gate = gated ? 0 : (p.without_gate || 0) + 1;
      if (p.status?.key === '_render') p.status = null;
      settle(p, pipeline);
      // T3: what kind of failure was it? A person or the machine has to fix a GPU, login or billing failure: pause at
      // the first one. The same failure twice in a row pauses too, whatever it is.
      const sig = progressed || result?.ok ? null : failureSignature(result?.error, this.activity.get(projectId)?.filter((a) => a.kind === 'error').slice(-5).map((a) => a.text));
      p.last_failure = sig ? { sig, at: now() } : null;
      if (p.state === 'queued') {
        // stopped (by the owner, the time limit or the studio closing): never carry on by itself. Resume is the owner's.
        if (abort.signal.aborted && this.restarting) { /* a planned restart: stays queued, the next runner picks it up */ }
        // stopped by the owner's Pause/Cancel and queued again: they pressed Resume since, so it carries on
        else if (abort.signal.aborted && me.byOwner) { /* Resume after Pause */ }
        // stopped by the token cap: the owner reads why, in the numbers, and Resume is theirs
        else if (abort.signal.aborted && me.overCap) pausedFor = me.overCap;
        else if (abort.signal.aborted) pausedFor = `The session was stopped${result?.error ? ` (${result.error})` : ''}. Press Resume to carry on.`;
        else if (sig && HARD.has(sig)) pausedFor = `${fixText(sig)}${result?.error ? ` (${String(result.error).slice(0, 200)})` : ''}`;
        else if (sig && prevSig === sig) pausedFor = `The same failure twice in a row (${sig}${result?.error ? `: ${String(result.error).slice(0, 200)}` : ''}). ${fixText(sig)}`.trim();
        else if (p.no_progress >= 2) pausedFor = `The last two sessions stopped without moving the project forward${result?.error ? ` (${result.error})` : ''}. Check the activity log, then resume.`;
        else if (p.without_gate >= MAX_SESSIONS_WITHOUT_GATE) pausedFor = `${MAX_SESSIONS_WITHOUT_GATE} sessions in a row ended without submitting or finishing a step. Check the journal, then resume.`;
        // `cause: login`: Claude Code's login expired or failed (the app offers Link Claude Code, then resumes)
        if (pausedFor) { p.state = 'paused'; p.needs_you = { text: pausedFor, at: now(), ...(sig === 'login' || loginTrouble(result?.error) ? { cause: 'login' } : sig ? { cause: sig } : {}) }; }
      }
    });
    if (themesMade) {
      const t = loadTheme(root, projectId);
      if (t?.samples?.length) event(root, projectId, { event: 'MUSIC_THEME', actor: 'studio', details: `${t.samples.length} themes to hear: ${t.samples.map((x) => x.name).filter(Boolean).join(', ').slice(0, 160)}` });
    }
    // a scene the owner OK'd while this session was still making the step: now that it is in review, send it back for
    // the next scene (svc/stages.mjs approveScene)
    const pendingMotion = loadProject(root, projectId).mfx?.motion_restart_pending;
    if (pendingMotion) {
      try {
        if (restartMotion(root, projectId, pendingMotion)) {
          const again = loadProject(root, projectId).mfx?.motion_remake_after;
          if (again) sceneRemaking(root, projectId, again);
          update(root, projectId, (p) => { delete p.mfx.motion_restart_pending; delete p.mfx.motion_remake_after; });
        }
      } catch { /* not in review yet: the next session end tries again */ }
    } else {
      // the owner is checking a scene: the next one is made meanwhile, one ahead
      try { startAhead(root, projectId); } catch (e) { this.log(`scene ahead: ${e.message}`); }
    }
    event(root, projectId, { event: 'SESSION_ENDED', details: `${result?.ok ? 'ok' : `error: ${result?.error}`} · ${minutes} min` });
    if (pausedFor) event(root, projectId, { event: 'NEEDS_YOU', details: pausedFor });
    this.addActivity(projectId, { kind: result?.ok ? 'info' : 'error', text: result?.ok ? `Session ended (${minutes} min).` : `Session ended: ${result?.error}` });
    this.log(`■ ${projectId}: ${result?.ok ? 'ok' : result?.error} (${minutes} min) → ${loadProject(root, projectId).state}`);
    clearInterval(peakTimer);
    if (lowest >= 0 && alone()) recordPeak(this.peakFile, freeAtStart - lowest);
    this.running.delete(projectId);
    this.emit('change');
    return result;
  }
}

const STOP_WAIT_MS = 20_000;
// The token cap's default (config.maxSessionTokens changes it): fresh tokens one session may use. Measured 2026-11-03
// over the 281 transcripts in ~/Mortiflix/state: the largest normal step used 387,618 (p99; median 101,351), the
// Gödel-Escher-Bach run that ballooned 1,156,096. Largest normal x 3, rounded down.
const DEFAULT_MAX_SESSION_TOKENS = 1_160_000;
// How often a running session's transcript is read for the cap (only the bytes added since, svc/tokens.mjs).
const TOKEN_CHECK_MS = 15_000;

// A session the last runner left running: its process group is stopped, only if it is still that process (the pid
// with the same start time) or the group outlived it (a pid is not reused while its group exists). Not on Windows:
// taskkill /PID on a reused pid would stop another program.
function stopOrphan(session, log) {
  const pid = Number(session?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return;
  const same = session.pid_start && procStart(pid) === session.pid_start;
  const groupLeft = !pidAlive(pid) && pidAlive(-pid);
  if (!same && !groupLeft) return;
  log(`stopping the session the last studio left running (pid ${pid})`);
  killTreeHard(pid);
}


// The sessions a planned restart stopped (run/restart.json), for the next runner; kept 30 min at most.
const restartFile = (root) => join(paths(root).run, 'restart.json');
export function markRestart(root, ids) {
  try { mkdirSync(paths(root).run, { recursive: true }); writeFileSync(restartFile(root), JSON.stringify({ at: new Date().toISOString(), projects: ids })); } catch { /* the next runner pauses them as before */ }
}
export function takeRestartMark(root, maxAgeMs = 30 * 60_000) {
  const f = restartFile(root);
  if (!existsSync(f)) return [];
  let ids = [];
  try { const j = JSON.parse(readFileSync(f, 'utf8')); if (Date.now() - Date.parse(j.at) <= maxAgeMs && Array.isArray(j.projects)) ids = j.projects.map(String); } catch { /* unreadable: none */ }
  try { rmSync(f); } catch { /* gone */ }
  return ids;
}
