// The Mortiflix service: the AI side of Mortiflix Studio. The desktop app (Rust) runs
// `node bin/mortiflix-service.mjs` and talks JSON lines over stdin/stdout, no port.
// Protocol: docs/mortiflix/protocol.md in the Mortiflix Studio app repo, with every message this file handles listed
// in docs/service-protocol.md here.
//   request  {id, type, params}
//   reply    {id, ok: true, result} | {id, ok: false, error: {code, message}}
//   event    {event, data}
// One handler per message type; the work lives in src/svc/*.mjs over the studio's engine (projects, gates, canvas,
// runner). The service runs the studio's runner itself, so the AI works ahead while the app is open.
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { REPO, studioRoot, ensureStudio, loadConfig, paths, UserError } from './studio.mjs';
import { createProject, loadProject, projectPaths, listProjects, startProject, readEvents, projectPipeline, update as updateProject, event as projectEvent } from './projects.mjs';
import { Runner, markRestart } from './runner.mjs';
import { findPipeline } from './pipelines.mjs';
import { canvasView, nodeAction, canvasPaths } from './canvas.mjs';
import { voiceOnOk } from './voiceonok.mjs';
import { voiceUsage } from './voiceusage.mjs';
import * as gates from './gates.mjs';
import { RenderQueue } from './renderq.mjs';
import { voiceOverview, voiceConfig, saveVoice, ENGINES as VOICE_ENGINES } from './voice/index.mjs';
import { boothStatus, addTake, keepTake, speakers, voicesDir } from './booth.mjs';
import { musicScore } from './svc/score.mjs';
import { listPacks, listFonts, getBrief, setBrief } from './svc/lookbrief.mjs';
import { listAllPacks, packKinds } from './svc/packs.mjs';
import { cleanPacks, setProjectPacks, setAssetPacks } from './svc/projectpacks.mjs';
import { buildPool, readPool, poolLines } from './svc/pool.mjs';
import * as framesSvc from './svc/frames.mjs';
import { addPack, confirmPack } from './svc/packadd.mjs';
import { getMotionBrief, setMotionBrief, getTransitionBrief, setTransitionBrief } from './svc/motionbrief.mjs';
import { STAGES, STAGE_NAMES, stageSet, restartMotion, approveScene, startAhead, remakeScene, allScenes, stageIndex, stageStatuses, stageDone, handOverToApp, remakesIf, reopenStage, saveLastStage, stageOf, mfxView, workStage, STAGE_MUSIC, STAGE_EDIT, STAGE_RENDER } from './svc/stages.mjs';
import { listPresets, getPreset, savePresetFull, deletePreset } from './svc/presets.mjs';
import { schemaView, normalizeBrief } from './svc/briefschema.mjs';
import { saveDraft as saveBriefDraft, getDraft, listDrafts, deleteDraft, addSource, listSources, removeSource, saveBriefPreset, listBriefPresets, deleteBriefPreset } from './svc/briefstore.mjs';
import { summarize } from './svc/briefsummary.mjs';
import { improveBrief } from './svc/briefai.mjs';
import { projectAssets, readProjectFile } from './svc/projectfiles.mjs';
import { readBrief, saveProjectBrief, STORED_ONLY, titleFromIdea } from './svc/briefmap.mjs';
import { addAsset, updateAsset, replaceAsset, removeAsset, useAsset, listAssets, setAssetHeard, heardLine } from './svc/assets.mjs';
import { hearSong } from './music/listen.mjs';
import { loadTheme, saveTheme, themeSamples, setCuePlan, cleanTheme } from './svc/theme.mjs';
import * as graph from './svc/graph.mjs';
import { placeSubtitles } from './svc/subplace.mjs';
import { scriptView, applyScriptEdits, remakesFor, scriptActionText, scriptLogged, saveDraft } from './svc/script.mjs';
import { lookView, useLook, moreLooks } from './svc/look.mjs';
import { readReviewSettings, saveReviewSettings } from './svc/reviewsize.mjs';
import { stillsView, drawLine, makeStills, okLine, okStill, fixStill, stillsMode, sendStillAnyway, retryStill } from './svc/stills.mjs';
import { appendChat, chatHistory, translateEvents, typedMove, quickReply, applyMove, initChat, actionText, askAI } from './svc/chat.mjs';
import { nameBeats, unnamed } from './svc/beatnames.mjs';
import { makeOptions } from './svc/options.mjs';
import { activeWork } from './svc/work.mjs';
import { tokenRuns, tokenRun } from './svc/tokens.mjs';
import { usageGet, onRow, readRows } from './svc/ledger.mjs';
import { exportTarget, deliverFromApp, postPlan, postSend } from './svc/export.mjs';
import * as setup from './svc/setup.mjs';
import { run as runAsync } from './svc/run.mjs';
import * as vnotes from './svc/videonotes.mjs';
import * as sync from './svc/sync.mjs';
import { createSetupCache } from './svc/setup-cache.mjs';
import { changeToken } from './svc/change-token.mjs';
import { voicesList } from './svc/newproject.mjs';
import { voicecastHandlers } from './svc/voicecast.mjs';
import { voiceMakeEstimate, lineTakeEstimate, voiceStepEstimate } from './svc/voicecost.mjs';
import { chosenSec } from './svc/chosenlength.mjs';
import { PAID_STEPS, stepEstimate, confirmCost, askFirst, okNow, rememberQuote, takeQuote, capSettings, saveDailyCap } from './svc/paidgate.mjs';
import { lanSettings, saveLan } from './svc/lanaccess.mjs';
import { musicExpected } from './svc/musicneed.mjs';
import { fillV3Briefs } from './svc/v3briefs.mjs';
import { speechPace } from './svc/pace.mjs';
import * as lessons from './svc/lessons.mjs';
import { sfxHandlers, soundsRunning } from './svc/sfx.mjs';
import { finalHandlers } from './svc/final.mjs';
import { handlers as artcraftHandlers } from './svc/artcraft.mjs';
import { revealPath } from './svc/reveal.mjs';
import { renameProject, duplicateProject, trashProject, restoreProject } from './svc/projectops.mjs';
import { installComponents, parseComponents } from './components.mjs';
import { setupHandlers } from './service-setup.mjs';
import { transcribeHandlers } from './svc/transcribe.mjs';
import { audioPeaks } from './svc/peaks.mjs';
import { musicHandlers } from './svc/elmusic.mjs';
import { restitchSoon, voiceStale, voiceLength, setVoiceSpeed } from './svc/restitch.mjs';
import { replayOn, replayCheck, installReplayFetch } from './replay.mjs';

// Replay mode (src/replay.mjs): the recorded ElevenLabs stand-in replaces fetch before anything can capture the real one.
if (replayOn()) installReplayFetch(() => studioRoot());

export const PROTOCOL = 1;
export { STAGES };

const version = () => {
  try { return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
};

class ProtocolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const bad = (message) => { throw new ProtocolError('bad_request', message); };
// a module's own refusal (err.code 'bad_request') answered as one
const asBad = (fn) => { try { return fn(); } catch (e) { if (e?.code === 'bad_request' && !(e instanceof ProtocolError)) bad(e.message); throw e; } };
const NODE_ID = /^[a-z][a-z0-9-]{1,23}$/;
const nodeId = (v, what = 'node') => (NODE_ID.test(String(v || '')) ? String(v) : bad(`${what} must be a piece id like s01`));
// What the chat can be "talking about" (protocol.md `chat.context`): the whole video, one piece (s01, b02, sf01,
// b01-2, m01, music, a01), the cut between two shots that has no transition yet (`cut:s02:s03`, the node area's cut
// pills) or a stage (`stage:look`). Ids are matched case-insensitively ("S03" is s03).
const CONTEXT = /^(?:video|[a-z][a-z0-9-]{1,23}|cut:[a-z][a-z0-9-]{1,23}:[a-z][a-z0-9-]{1,23}|stage:[a-z]{3,20})$/;
const contextOf = (v) => {
  if (v === undefined || v === null || v === '' || v === 'video') return 'video';
  const c = String(v).trim().toLowerCase();
  return CONTEXT.test(c) ? c : bad('context must be "video", a piece id like s01, a cut like cut:s02:s03 or a stage like stage:look');
};
const assetId = (v) => (/^a\d{2,3}$/.test(String(v || '')) ? String(v) : bad('asset must be an id like a01'));
const opt = (v, n = 4000) => (v === undefined || v === null ? undefined : String(v).slice(0, n));

// Read-only requests (R3): runStdio answers them without waiting for a slow request in front of them (a Claude call, a
// render step). Everything else keeps the stdin order. Only list a type here when it changes nothing.
export const FAST = new Set([
  'project.list', 'files.reveal', 'state.get', 'work.get', 'service.drain', 'models.status', 'stage.status', 'voices.list', 'presets.list', 'presets.get', 'voice.list',
  'assets.list', 'packs.list', 'packs.files', 'packs.kinds', 'notes.list', 'activity.list', 'render.list', 'setup.status', 'keys.list', 'components.status',
  'chat.history', 'project.events', 'project.files', 'project.file.read', 'tokens.runs', 'tokens.run', 'usage.get', 'script.get', 'voice.lines', 'voicemusic.view', 'voice.speed.get', 'music.cues', 'stills.get',
  'brief.schema', 'brief.draft.get', 'brief.draft.list', 'brief.summary', 'sources.list',
  'audio.peaks', 'look.get', 'settings.get', 'frames.get', 'cast.get', 'step.cost', 'music.plan.get', 'handoff.get', 'sync.check', 'final.status',
]);
// A read that comes right behind a quick request still sees its result; behind a slow one it goes ahead after this.
export const FAST_WAIT_MS = 100;
// Stop requests (P051): answered at once, never queued behind a slow request (a Claude call, a paid make), so Pause and
// Cancel stop a running session while that request still runs. Both are short, synchronous writes under the project
// lock; a request still running later sees the paused or cancelled state (settle and the cost OK never leave it).
export const CONTROL = new Set(['project.pause', 'project.resume', 'project.cancel', 'sfx.cancel']); // sfx.cancel only sets a flag (svc/sfx.mjs cancelSounds)

// `runner`: run the studio's runner in this process (the app's service does; tests mostly don't).
// `tickMs`: how often the open project is looked at (graph, chat, statuses) while nothing else pokes it.
export function createService({ root = studioRoot(), send, runner: wantRunner = false, tickMs = 1500, setupWorker, fetch: fetchFn = globalThis.fetch, usagePollMs = 5000, reveal: revealRun, exit = null } = {}) {
  // replay is all or nothing: a studio that isn't a replay studio (or a bad pack) stops the service here
  if (replayOn()) { replayCheck(root); installReplayFetch(() => root); console.error(`mortiflix-service: REPLAY MODE (${process.env.MFX_REPLAY}): recorded generations only, nothing paid`); }
  const state = {
    project: null,
    stage: 0,
    stages: STAGES.map(() => ({ kind: 'notStarted' })),
    line: '',
    context: 'video',
  };
  const emit = (event, data) => send({ event, data });
  // usage.changed: one event per burst of new ledger rows (debounced 1 s)
  let usageTimer = null;
  let usageLast = null;
  const bumpUsage = (row) => {
    usageLast = row;
    if (usageTimer) return;
    usageTimer = setTimeout(() => { usageTimer = null; if (!closed) emit('usage.changed', { at: usageLast.at, project: usageLast.project, provider: usageLast.provider, kind: usageLast.kind }); }, 1000);
    usageTimer.unref?.();
  };
  let usageSeen = null;
  const offUsage = onRow((r, row) => { if (r === root) { bumpUsage(row); try { usageSeen = readRows(root).length; } catch { /* none */ } } });
  // rows appended by other processes (a session's ElevenLabs scripts) are noticed within 5 s
  try { usageSeen = readRows(root).length; } catch { /* no ledger yet */ }
  const usagePoll = setInterval(() => {
    try { const rows = readRows(root); if (usageSeen !== null && rows.length > usageSeen) bumpUsage(rows[rows.length - 1]); usageSeen = rows.length; } catch { /* no ledger yet */ }
  }, usagePollMs);
  usagePoll.unref?.();
  const options = makeOptions({ root, emit, config: (id) => { const c = loadConfig(root); let pb = null; try { pb = loadProject(root, id).backend; } catch { /* no project */ } return { backend: c.chatBackend || pb || c.backend }; }, count: () => readReviewSettings(root).options.count });
  const setupCache = createSetupCache(root, setupWorker ? { worker: setupWorker } : {});
  let installing = null; // component ids being installed (components.install)
  const activity = new Map(); // project id -> recent activity rows
  let runner = null;
  // a drained restart under way (service.restart {drain}): what it waits for, for the app's "Queued: the studio restarts…"
  let drainInfo = null;
  let runnerNote = '';
  let queue = null;
  let lastStatus = '';
  // Projects other tabs have open (project.open): each gets its own `status` and `project.changed`, so a tab on one
  // project never needs the service's open project to be its own. id -> last opened (ms); the oldest drop off.
  const watched = new Map();
  const WATCH_MAX = 8;
  const lastWatchedStatus = new Map();
  let lastNodes = new Map();
  const lastProjectSig = new Map(); // project id -> last announced state|needs_you|deliverables (project.changed)
  let dirty = true; // something happened that the tick must look at (poke, request, job, activity)
  let lastToken = '';
  let lastFull = 0;
  const ticks = { full: 0, skipped: 0 }; // for the tests: how many ticks did the whole look
  const HEARTBEAT_MS = 30_000; // a full look at least this often, in case a change left no mark the token sees
  let lastWork = '';
  let work = null; // the last work.active data for the open project
  let timer = null;
  let interval = null;
  let closed = false;

  const onJob = (job) => { dirty = true; try { emit('render.job', queue.view(job)); } catch { /* gone */ } };
  // No local models (owner, 2026-11-01: local generation is bloat): no model keeper, nothing loaded on the graphics card.
  if (wantRunner) {
    try {
      runner = new Runner(root, { log: (l) => console.error(l) });
      runner.acquire();
      queue = runner.renders;
      const inner = queue.onChange;
      queue.onChange = (job) => { inner(job); onJob(job); };
      runner.on('change', () => poke());
      runner.on('activity', (a) => onActivity(a));
      runner.on('nodes', (d) => emit('node.changed', { project: d.project, rev: null, nodes: d.nodes.map((n) => ({ id: n, kind: 'line' })) }));
      runner.loop({ watch: true }).catch((e) => { runnerNote = `The AI stopped working: ${e.message}`; console.error(e); poke(); });
    } catch (e) {
      runnerNote = String(e.message || e);
      runner = null;
      console.error(`mortiflix-service: no runner: ${runnerNote}`);
    }
  }
  if (!queue) queue = new RenderQueue({ logDir: join(paths(root).run, 'renders'), onChange: onJob });

  function onActivity(a) {
    dirty = true;
    const list = activity.get(a.project) || [];
    list.push(a);
    if (list.length > 300) list.splice(0, list.length - 300);
    activity.set(a.project, list);
    if (a.project !== state.project?.id) return;
    emit('activity', a);
    if (['text', 'tool'].includes(a.kind)) poke();
  }

  const projectId = () => state.project?.id || null;
  const askFor = (id) => (loadConfig(root).backend === 'demo' ? null : (prompt) => askAI(root, id, prompt, { maxTokens: 300, role: 'lesson' }));
  // A queued project's place in the runner's queue (svc/sessionslots.mjs): ahead = queued projects before it, oldest first.
  const runnerQueue = (id) => {
    if (!runner) return null;
    const q = runner.queue();
    const at = q.findIndex((x) => x.id === id);
    return { ahead: at < 0 ? null : at, running: runner.running.size };
  };
  const needProject = (params) => {
    const id = params?.project || state.project?.id;
    if (!id) throw new ProtocolError('no_project', 'open or make a project first');
    return String(id);
  };

  // The AI's one line for the stage bar hint and the chat's Now line (doc 37: one source).
  function liveLine(p) {
    if (!p) return runnerNote || '';
    if (p.state === 'paused' && p.needs_you) return `Needs you: ${p.needs_you.text}`.slice(0, 300);
    // what the AI is doing, in plain words with progress (work.active `doing`)
    if (p.session?.running && work?.project === p.id && work.doing) return work.doing.slice(0, 300);
    if (p.status?.text) return p.status.text;
    const last = (activity.get(p.id) || []).filter((a) => ['text', 'tool'].includes(a.kind)).at(-1);
    if (p.session?.running && last) return String(last.text).split('\n')[0].slice(0, 200);
    if (runnerNote && p.state === 'queued') return runnerNote.slice(0, 300);
    // Edit the video skips the AI's build and final (the app makes the video): nothing is delivered until Render.
    const inApp = p.state === 'delivered' && Object.values(p.steps || {}).some((s) => s?.state === 'skipped') && ['build', 'final'].every((k) => !p.steps?.[k] || p.steps[k].state === 'skipped');
    if (inApp) return 'The AI\'s part is done: finish in Edit, then Render.';
    return { draft: 'Not started yet.', queued: 'Starting…', waiting: 'Waiting for you.', delivered: 'Done: the video is delivered.', cancelled: 'Stopped. Press Resume to carry on.', paused: 'Paused.' }[p.state] || '';
  }

  function status(force = false) {
    const id = projectId();
    let p = null;
    if (id) {
      try {
        p = loadProject(root, id);
        state.project = p;
        state.stages = stageStatuses(root, id, { running: Boolean(p.session?.running) });
      } catch (e) { console.error(`status: ${e.message}`); }
    }
    state.line = liveLine(p);
    const data = { line: state.line, stage: state.stage, project: id, stages: state.stages, state: p?.state ?? null, needs_you: p?.needs_you ?? null, title: p?.title ?? null };
    const key = JSON.stringify(data);
    if (force || key !== lastStatus) { lastStatus = key; emit('status', data); }
    if (p) announceChange(p);
    for (const wid of watched.keys()) {
      if (wid === id) continue;
      let wp;
      let wdata;
      try {
        wp = loadProject(root, wid);
        wdata = { line: liveLine(wp), stage: null, project: wid, stages: stageStatuses(root, wid, { running: Boolean(wp.session?.running) }), state: wp.state ?? null, needs_you: wp.needs_you ?? null, title: wp.title ?? null };
      } catch { watched.delete(wid); lastWatchedStatus.delete(wid); continue; }
      const wkey = JSON.stringify(wdata);
      if (force || wkey !== lastWatchedStatus.get(wid)) { lastWatchedStatus.set(wid, wkey); emit('status', wdata); }
      announceChange(wp);
    }
  }

  function announceChange(p) {
    const sig = JSON.stringify([p.state, p.needs_you ?? null, p.deliverables ?? null]);
    if (lastProjectSig.get(p.id) !== sig) { lastProjectSig.set(p.id, sig); emit('project.changed', { id: p.id, state: p.state, needs_you: p.needs_you, deliverables: p.deliverables }); }
  }

  function watch(id) {
    watched.delete(id);
    watched.set(id, Date.now());
    while (watched.size > WATCH_MAX) { const old = watched.keys().next().value; watched.delete(old); lastWatchedStatus.delete(old); }
  }

  // The owner's answers to a questions submission, given in the chat after it arrived: { question id: answer }.
  function ownerAnswers(p, sub) {
    const out = {};
    for (const [qid, a] of Object.entries(p.mfx?.answers || {})) {
      if (sub && a?.step === sub.step && String(a.at || '') >= String(sub.submitted_at || '')) out[qid] = a.answer;
    }
    return out;
  }
  const nextStepName = (pipeline, key) => (pipeline.steps.find((x) => (x.after || []).includes(key))?.name || 'next step').toLowerCase();

  // Policies the app's flow needs (docs 30, 37): a questions step waits for the owner (owner, 2026-10-18: nothing
  // after the brief starts until every question in the chat is answered) and goes on with their answers once the last
  // one is in; `config.mfxQuestionsBlock: false` goes on with the defaults at once, as before. A stage the owner moved
  // on from keeps what arrives "as it is".
  function policies(id) {
    const config = loadConfig(root);
    const p = loadProject(root, id);
    if (!['queued', 'waiting'].includes(p.state)) return;
    const pipeline = projectPipelineOf(id);
    const S = stageSet(pipeline);
    const done = mfxView(p, S).stages_done || {};
    for (const s of gates.stepView(p, pipeline).filter((x) => x.state === 'in_review')) {
      try {
        if (s.review === 'questions') {
          const sub = gates.submissions(root, id).find((x) => x.step === s.key && x.version === s.version);
          if (sub && config.mfxQuestionsBlock === false && sub.questions.every((q) => q.default !== null)) {
            gates.respond(root, id, s.key, s.version, { verdict: 'approve', overall: 'Going on with the defaults (the owner can change any answer in the chat).' });
            const row = appendChat(root, id, { role: 'ai', text: `Going with: ${sub.questions.map((q) => `${q.text} → ${q.default}`).join(' · ')}. Change any of these in the chat.`, card: { kind: 'defaults', questions: sub.questions } });
            emit('chat.message', row);
            continue;
          }
          const given = ownerAnswers(p, sub);
          if (sub && sub.questions.length && sub.questions.every((q) => given[q.id] !== undefined)) {
            gates.respond(root, id, s.key, s.version, { verdict: 'approve', overall: 'Every question answered in the chat.', answers: given });
            const row = appendChat(root, id, { role: 'ai', text: `Thanks, that's every answer. Starting the ${nextStepName(pipeline, s.key)} now.` });
            emit('chat.message', row);
            runner?.wake();
            continue;
          }
        }
        if (done[S.keys[stageOf(s, S)]]) stageDone(root, id, stageOf(s, S), { reason: 'Moved on earlier' });
      } catch (e) { console.error(`policy ${s.key}: ${e.message}`); }
    }
  }

  // Beats without a name get one from the user's own AI (once per words; the demo titles them from the words). A
  // failed call is not tried again for 10 minutes; the words' own title shows meanwhile.
  const naming = { busy: false, failedAt: new Map() };
  function nameBeatsSoon(id) {
    if (naming.busy || Date.now() - (naming.failedAt.get(id) || 0) < 600_000) return;
    let todo;
    try { todo = unnamed(root, id); } catch { return; }
    if (!todo.length) return;
    naming.busy = true;
    nameBeats(root, id, { ask: (prompt) => askAI(root, id, prompt, { role: 'name' }) })
      .then((r) => { if (r.named.length && id === projectId()) emit('node.changed', { project: id, rev: null, nodes: r.named.map((b) => ({ id: b, kind: 'beat', named: true })) }); })
      .catch((e) => { naming.failedAt.set(id, Date.now()); console.error(`beat names: ${e.message}`); })
      .finally(() => { naming.busy = false; });
  }

  function tick() {
    timer = null;
    if (closed) return;
    const id = projectId();
    // Video Notes (opt-in): two stats per scene waiting on the tablet; nothing else when it is off or unchanged
    if (id) vnotes.pollTablet(root, id, { emit, actions: { ask: askFor(id), send: (beat) => { // OK with notes: ONE fix that remakes THIS scene (not the next); it comes back to review and is queued again
        const r = lessons.sendNotes(root, id, beat, { fix: (_n, text) => {
          remakeScene(root, id, beat, text);
          return null;
        } });
        emit('lessons.changed', { project: id }); runner?.wake(); poke(); return r;
      }, approve: (beat) => handlers['motion.scene.approve']({ project: id, beat }),
        // a style frame on the tablet: OK with notes = remake THIS frame, OK with none = the frame is OK'd (and the next round starts); the app wins
        frameFix: (frame) => handlers['frames.fix']({ project: id, frame }), frameOk: (frame) => handlers['frames.ok']({ project: id, frame }),
        stillFix: (line) => handlers['stills.fix']({ project: id, line }), stillOk: (line) => handlers['stills.ok']({ project: id, line }) } }).catch((e) => console.error(`video notes: ${e.message}`));
    // Nothing poked and no file the project reads changed: skip the whole look (R6). The token is a cheap stat walk.
    const token = id ? changeToken(root, id) : '';
    if (!dirty && token === lastToken && Date.now() - lastFull < HEARTBEAT_MS) { ticks.skipped++; return; }
    ticks.full++;
    dirty = false;
    lastToken = token;
    lastFull = Date.now();
    if (id) {
      try {
        for (const row of translateEvents(root, id)) emit('chat.message', row);
        policies(id);
        nameBeatsSoon(id);
        const g = canvasView(root, id);
        const changed = [];
        const seen = new Map();
        for (const [nid, n] of Object.entries(g.nodes)) {
          const sig = `${n.current}|${n.state}|${n.owner}|${n.pending?.id || ''}|${n.missing ? 1 : 0}`;
          seen.set(nid, sig);
          if (lastNodes.get(nid) !== sig) changed.push({ id: nid, kind: n.kind, current: n.current, state: n.state, owner: n.owner, missing: Boolean(n.missing) });
        }
        if (lastNodes.size && changed.length) emit('node.changed', { project: id, rev: g.rev, nodes: changed });
        else if (!lastNodes.size && seen.size) emit('node.changed', { project: id, rev: g.rev, nodes: [], all: true });
        lastNodes = seen;
        refreshWork(id, g);
      } catch (e) { console.error(`tick: ${e.message}`); }
    }
    status();
  }
  // What the AI is working on (svc/work.mjs): sent as `work.active` whenever it changes (and on hello).
  function refreshWork(id, g, force = false) {
    let p;
    try { p = loadProject(root, id); } catch { return; }
    const render = queue.list().find((j) => j.project === id && j.state === 'running') || null;
    work = activeWork(root, id, { running: Boolean(p.session?.running), g, activity: activity.get(id) || [], render });
    const key = JSON.stringify(work);
    if (force || key !== lastWork) { lastWork = key; emit('work.active', work); }
  }

  function poke(ms = 150) { dirty = true; schedule(ms); }
  function schedule(ms) {
    if (closed) return;
    if (timer && ms > 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    timer.unref?.();
  }
  // the timer only checks the token: it does not mark dirty
  if (tickMs > 0) { interval = setInterval(() => schedule(0), tickMs); interval.unref?.(); }

  const projectPipelineOf = (id) => projectPipeline(root, id);

  function openProject(p, stage = null) {
    state.project = p;
    state.stage = stage ?? mfxView(p).stage ?? 0;
    lastNodes = new Map();
    lastWork = '';
    work = null;
    poke(0);
  }

  function chatRow(id, row) {
    const r = appendChat(root, id, row);
    emit('chat.message', { ...r, project: id });
    return r;
  }

  // Copy files in the background (big footage takes a while): progress and the result come as events.
  function copyAssets(id, list, { then = null } = {}) {
    const run = async () => {
      const added = [];
      for (const a of list) {
        try {
          const asset = await addAsset(root, id, { path: a.path, use: a.use, where: a.where, note: a.note, onProgress: (pr) => emit('assets.progress', { project: id, ...pr }) });
          added.push(asset);
          emit('assets.added', { project: id, asset });
          chatRow(id, { role: 'action', text: `Added ${asset.name} (${asset.id})` });
          if (asset.kind === 'audio' && asset.use === 'reference') hearAsset(id, asset).catch(() => {});
        } catch (e) {
          emit('assets.failed', { project: id, path: String(a.path || '').slice(0, 1000), message: e.message });
        }
      }
      if (then) {
        try { await then(added); } catch (e) { emit('assets.failed', { project: id, message: e.message }); chatRow(id, { role: 'system', text: `Couldn't start: ${e.message}` }); }
      }
      poke();
    };
    run().catch((e) => console.error(e));
  }

  // A song handed over for reference ("Like this song") is heard: its tempo, key and chords go on the asset, so the
  // music step reads them in the brief instead of guessing. In the background, a few seconds per song.
  function hearAsset(id, asset) {
    return hearSong(asset.path).then((heard) => {
      const a = setAssetHeard(root, id, asset.id, heard);
      emit('assets.added', { project: id, asset: a, heard: true });
      chatRow(id, { role: 'action', text: `Heard ${a.name} (${a.id}): ${heardLine(heard)}` });
      return a;
    }).catch((e) => { chatRow(id, { role: 'system', text: `Couldn't hear ${asset.name}: ${e.message}` }); throw e; });
  }

  const cleanAssetList = (p) => {
    const raw = Array.isArray(p?.assets) ? p.assets : Array.isArray(p?.paths) ? p.paths.map((x) => ({ path: x })) : p?.path ? [{ path: p.path }] : [];
    return raw.slice(0, 200).map((a) => (typeof a === 'string' ? { path: a } : { path: a?.path, use: a?.use ?? p?.use, where: a?.where ?? p?.where, note: a?.note ?? p?.note }))
      .filter((a) => typeof a.path === 'string' && a.path);
  };

  // A paid new take or new words of one voice line (C301's one-time quote, src/svc/paidgate.mjs): without confirm it
  // answers the estimate and remembers that price; with confirm it goes on only for a price the owner was shown for
  // exactly this line and text (once), else `cost_changed`. Returns the estimate to answer, or null to go on.
  function paidTakeGate(id, line, text, p) {
    const e = lineTakeEstimate(root, id, line, text);
    if (!e.needs_confirm) return null;
    const what = { line, text: text ?? null, characters: e.characters };
    if (p?.confirm !== true) { rememberQuote(id, 'voice.take', what, e.credits_estimate); return e; }
    try { takeQuote(id, 'voice.take', what, e.credits_estimate, root); } catch (err) { throw new ProtocolError(err.code || 'cost_changed', err.message); }
    return null;
  }

  // project.new's work (one Create): the project, its chat, theme, packs and brief, opened; started unless start: false
  const newRequests = new Map(); // project.new request_id -> its first result, the last 50
  function makeProject(p) {
    const slug = String(p?.preset || p?.pipeline || 'explainer');
    const pipeline = findPipeline(root, slug);
    const answers = {};
    for (const q of pipeline.intake) if (q.type !== 'files' && q.default !== undefined && q.default !== null && q.default !== '') answers[q.id] = q.default;
    const fromBrief = readBrief(root, p, pipeline); // the New project brief (plan 52); the flat fields below still win
    Object.assign(answers, fromBrief.answers);
    Object.assign(answers, p?.answers && typeof p.answers === 'object' ? p.answers : {});
    const ideaField = (pipeline.intake.find((q) => q.type === 'long' && q.required) || pipeline.intake.find((q) => q.type === 'long'))?.id;
    if (fromBrief.brief?.idea && ideaField) answers[ideaField] = fromBrief.brief.idea;
    if (p?.idea !== undefined && ideaField) answers[ideaField] = String(p.idea).slice(0, 20_000);
    const assets = cleanAssetList(p);
    const start = p?.start !== false;
    if (start) {
      for (const q of pipeline.intake.filter((x) => x.required)) {
        if (q.type === 'files' ? !assets.length : !String(answers[q.id] ?? '').trim()) bad(`${q.label || q.id}: ${q.type === 'files' ? 'add a file under Assets' : 'this is needed'}`);
      }
    }
    if (p?.backend !== undefined && p.backend !== 'demo') bad('backend: only "demo" can be pinned per project');
    const packs = cleanPacks(root, p?.packs);
    const project = createProject(root, { pipeline: slug, title: String(p?.title ?? p?.name ?? fromBrief.brief?.title ?? '').trim() || titleFromIdea(answers[ideaField]), answers, backend: p?.backend === 'demo' ? 'demo' : null });
    initChat(root, project.id);
    if (answers[ideaField]) appendChat(root, project.id, { role: 'user', text: answers[ideaField] });
    const theme = p?.music?.theme || p?.music_theme || null;
    if (theme) saveTheme(root, project.id, { ...theme, picked_by: 'you' });
    else if (pipeline.music_theme) saveTheme(root, project.id, { ...pipeline.music_theme, picked_by: 'you' }, { by: 'ai' });
    // the packs picked at the start: every step that would ask for one uses it
    setProjectPacks(root, project.id, packs);
    if (fromBrief.brief) saveProjectBrief(root, project.id, fromBrief);
    saveLastStage(root, project.id, 0);
    openProject(loadProject(root, project.id), 0);
    const go = async () => {
      if (!start) return;
      startProject(root, project.id);
      runner?.wake();
      poke();
    };
    if (assets.length) copyAssets(project.id, assets, { then: go });
    else go().catch((e) => chatRow(project.id, { role: 'system', text: `Couldn't start: ${e.message}` }));
    return { project: loadProject(root, project.id), assets_pending: assets.length, ...(fromBrief.brief ? { brief_saved: true, stored_only: STORED_ONLY, errors: [] } : {}) };
  }

  const handlers = {
    // cast, per-line tags/role/pause, verbatim check (svc/voicecast.mjs); a changed line is a Fix on that line only
    ...voicecastHandlers({ root, needProject, retake: (id, l, r) => {
      const e = nodeAction(root, id, nodeId(l.id, 'line'), { action: 'fix', text: `Read this line again as written in voice/lines.json (role ${l.role || 'narrator'}, voice and settings from voice/cast.json), keeping it inside its slot.` }).edit;
      chatRow(id, { role: 'action', text: `Re-read ${l.id}${r.changed.tags ? ' with new tags' : ''}${r.changed.role ? ` as ${l.role || 'narrator'}` : ''}`, edit: e.id, refs: [l.id] });
      runner?.wake();
      return e;
    } }),
    hello: (p) => {
      const result = { service: 'mortiflix-service', version: version(), protocol: PROTOCOL, studio: root, client: String(p?.client || ''), runner: Boolean(runner), runner_note: runnerNote || null, types: Object.keys(handlers).sort() };
      setImmediate(() => { status(true); if (projectId()) { try { refreshWork(projectId(), canvasView(root, projectId()), true); } catch { /* no canvas yet */ } } });
      return result;
    },
    // state.project is the open project's record: its id is what loadProject takes (passing the record made state and
    // needs_you always null, so a paused project never showed as paused here)
    'state.get': () => { const p = projectId() ? (() => { try { return loadProject(root, projectId()); } catch { return null; } })() : null; return { project: state.project, stage: state.stage, stages: state.stages, line: state.line, context: state.context, state: p?.state ?? null, needs_you: p?.needs_you ?? null }; },

    // ---- projects ----
    'files.reveal': (p) => asBad(() => revealPath(root, p?.path, revealRun ? { run: revealRun } : {})),
    // v3 projects: where the work is (svc/stages.mjs workStage); older sets: the stage last opened (mfx.stage)
    'project.list': () => listProjects(root).map((p) => ({ id: p.id, title: p.title, state: p.state, pipeline: p.pipeline, created_at: p.created_at, updated_at: p.updated_at ?? null, stage: (() => { try { const pl = projectPipeline(root, p.id); if (pl?.stage_set === 'v3') return workStage(p, pl); } catch { /* the stage last opened */ } return mfxView(p).stage ?? 0; })(), delivered: p.state === 'delivered', needs_you: p.needs_you ?? null, set: p.pipeline?.stage_set || p.pipeline?.slug || null })),
    // request_id (optional, the client's id for one Create click): a repeat of it, e.g. Try again after the answer was
    // lost, answers with the project the first one made instead of making a second (IETF Idempotency-Key draft:
    // a repeat after completion returns the first result). project.new has no await and runs in stdin order, so a
    // repeat can never arrive while the first is still running.
    'project.new': (p) => {
      const rid = p?.request_id === undefined || p?.request_id === null ? null : String(p.request_id).slice(0, 200);
      if (rid && newRequests.has(rid)) {
        const first = newRequests.get(rid);
        const project = loadProject(root, first.project.id);
        openProject(project, 0);
        return { ...first, project, repeated: true };
      }
      const result = makeProject(p);
      if (rid) { newRequests.set(rid, result); while (newRequests.size > 50) newRequests.delete(newRequests.keys().next().value); }
      return result;
    },
    'project.open': (p) => {
      if (!p?.id) bad('project.open needs an id');
      // v3: a Look or Motion held only by a pick the app never asks for starts with "the AI decides" (svc/v3briefs.mjs)
      try { if (fillV3Briefs(root, String(p.id)).length) runner?.wake(); } catch (e) { console.error(`v3 briefs ${p.id}: ${e.message}`); }
      // a Motion submission whose scene was never marked built (a session submitted it): it waits for the owner's OK
      try { const pid = String(p.id); if (gates.stepView(loadProject(root, pid), projectPipeline(root, pid)).some((x) => x.key === 'animatic' && x.state === 'in_review')) lessons.scenesSubmitted(root, pid); } catch (e) { console.error(`scenes ${p.id}: ${e.message}`); }
      // a scene Fix finished across a restart: its clip becomes the scene's new version now (idempotent)
      import('./quickanimatic.mjs').then((q) => q.syncSceneEdits(projectPaths(root, String(p.id)).work)).then((d) => { for (const x of d) projectEvent(root, String(p.id), { event: 'SCENE_VERSION', details: `${x.beat}: ${x.file} is the scene's new version` }); }).catch((e) => console.error(`scene versions ${p.id}: ${e.message}`));
      const project = loadProject(root, String(p.id));
      watch(project.id);
      openProject(project);
      return { project, stage: state.stage };
    },
    'project.close': () => { state.project = null; state.stage = 0; lastNodes = new Map(); work = null; lastWork = ''; emit('work.active', { project: null, running: false, step: null, nodes: [], current: null, doing: '', progress: null, shots_eta_min: null, before_shots: [] }); status(true); return { closed: true }; },
    // What the AI is working on now (also the work.active event): the pieces it makes or remakes, in plain words.
    // `queue`: queued for a session slot (sessions.parallel), the queued projects before this one; null when it isn't waiting for one
    // a drained restart under way, or {draining: false}
    'service.drain': () => drainInfo ?? { draining: false },
    'work.get': (p) => { const id = needProject(p); const pr = loadProject(root, id); return { drain: drainInfo, ...activeWork(root, id, { running: Boolean(pr.session?.running), g: canvasView(root, id), activity: activity.get(id) || [], render: queue.list().find((j) => j.project === id && j.state === 'running') || null }), queue: runnerQueue(id) }; },
    'project.start': (p) => { const r = startProject(root, needProject(p)); runner?.wake(); poke(); return { project: r }; },
    'project.pause': (p) => { const id = needProject(p); gates.pause(root, id); runner?.stopProject(id); poke(); return { paused: true }; },
    'project.resume': (p) => { gates.resume(root, needProject(p)); runner?.wake(); poke(); return { resumed: true }; },
    // "Let the AI take over": after a step paused because the studio's own code couldn't finish it, one full session may try
    'project.takeover': (p) => { gates.takeover(root, needProject(p)); runner?.wake(); poke(); return { resumed: true, takeover: true }; },
    // Home's ⋯ menu (svc/projectops.mjs): rename, a copy without a session or paid call, delete into the trash + its Undo
    'project.rename': (p) => { const r = renameProject(root, needProject(p), p?.title); if (state.project?.id === r.project) state.project = loadProject(root, r.project); poke(); return r; },
    'project.duplicate': (p) => { const r = duplicateProject(root, needProject(p), { upto: p?.upto ? String(p.upto) : null, title: p?.title }); poke(); return r; },
    'project.delete': (p) => {
      const id = needProject(p);
      // a session here, a session of another runner (the CLI's), or a render of it still running
      if (runner?.running?.has(id) || loadProject(root, id).session?.running || queue.activeFor(id).some((j) => j.state === 'running') || soundsRunning(projectPaths(root, id).work)) throw new UserError('it is being made right now: stop it before deleting');
      const r = trashProject(root, id);
      watched.delete(id); lastProjectSig.delete(id);
      if (state.project?.id === id) handlers['project.close']();
      poke(); return r;
    },
    'project.restore': (p) => { const r = restoreProject(root, needProject(p)); poke(); return r; },
    // service.restart {drain?, wait_min?}: a planned restart. drain: start no new session and wait (up to wait_min, default
    // 10) for the running ones to end; then the service closes (the sessions still running are picked up again by the next
    // service, runner.acquire) and the app's bridge starts it again. Answers before closing.
    'service.restart': (p) => {
      if (!exit) bad('this service cannot restart itself (no host to start it again)');
      const drain = p?.drain === true;
      const waitMin = Number(p?.wait_min ?? 10);
      if (!Number.isFinite(waitMin)) bad('wait_min is a number of minutes'); // NaN would skip the drain entirely
      const waitMs = Math.min(60, Math.max(0, waitMin)) * 60_000;
      const running = runner ? [...runner.running.keys()] : [];
      // answered at once (a long wait here would hold every other request): the drain runs on its own
      (async () => {
        const t0 = Date.now();
        if (drain && runner) {
          runner.draining = true;
          const title = (pid) => { try { return loadProject(root, pid).title || pid; } catch { return pid; } };
          const tell = () => { const w = [...runner.running.keys()]; drainInfo = { draining: true, waiting_for: w, titles: Object.fromEntries(w.map((x) => [x, title(x)])), started_at: new Date(t0).toISOString(), wait_min: waitMs / 60_000 }; emit('service.drain', drainInfo); };
          tell();
          while (runner.running.size && Date.now() - t0 < waitMs) {
            await new Promise((ok) => setTimeout(ok, 1000));
            if (runner.running.size !== drainInfo.waiting_for.length) tell();
          }
        }
        const still = runner ? [...runner.running.keys()] : [];
        console.error(`mortiflix-service: restart${drain ? ` after ${Math.round((Date.now() - t0) / 1000)} s of drain` : ''}; picked up after: ${still.join(', ') || 'none'}`);
        exit();
      })();
      return { restarting: true, drain, wait_min: waitMs / 60_000, running };
    },
    'project.cancel': (p) => { const id = needProject(p); gates.cancel(root, id); runner?.stopProject(id); poke(); return { cancelled: true }; },
    // The owner's verdict on a step in review (same code path as POST /projects/:id/reviews/:step/:version): OK, or send it
    // back with notes. version defaults to the one waiting now; a stale version is refused by gates.respond.
    'review.respond': (p) => {
      const id = needProject(p);
      const stepKey = String(p?.step || bad('review.respond needs a step'));
      const verdict = p?.verdict === 'ok' || p?.verdict === 'approve' ? 'approve' : p?.verdict === 'changes' ? 'changes' : bad('verdict: ok or changes');
      let version = p?.version;
      if (version === undefined || version === null) {
        const view = gates.stepView(loadProject(root, id), projectPipeline(root, id)).find((s) => s.key === stepKey);
        if (!view) bad(`no step ${stepKey}`);
        version = view.version;
      }
      if (!Number.isInteger(version) || version < 1) bad('version must be a whole number from 1');
      const notes = typeof p?.notes === 'string' ? (p.notes.trim() ? [{ text: p.notes }] : []) : Array.isArray(p?.notes) ? p.notes : [];
      const given = p?.answers && typeof p.answers === 'object' && !Array.isArray(p.answers) ? p.answers : {};
      const pr = loadProject(root, id);
      // The app's OK ends with this call after the answers are sent: an OK on a step already approved (the last answer
      // approved it) is a no-op, not an error.
      const rec = pr.steps?.[stepKey];
      if (verdict === 'approve' && rec && ['approved', 'done'].includes(rec.state) && rec.version === version) return { step: stepKey, version, verdict, project_state: pr.state, already: true };
      // The answers given in the chat on this submission count, so an OK after them approves with them (none needed
      // when the submission has no questions).
      const sub = gates.submissions(root, id).find((x) => x.step === stepKey && x.version === version);
      const answers = { ...ownerAnswers(pr, sub), ...given };
      let r;
      try { r = gates.respond(root, id, stepKey, version, { verdict, overall: String(p?.overall ?? ''), notes, answers }); }
      catch (e) { if (e instanceof gates.GateError) bad(e.message); throw e; }
      runner?.wake(); poke();
      return r;
    },
    // What Claude submitted for a step version, whole (the SUBMITTED event's details stop at 300 characters): the note,
    // its questions and its items (text items with their words). version defaults to the newest submitted one.
    'review.submission': (p) => {
      const id = needProject(p);
      const stepKey = String(p?.step || bad('review.submission needs a step'));
      const all = gates.submissions(root, id).filter((s) => s.step === stepKey);
      const sub = p?.version == null ? all.sort((a, b) => b.version - a.version)[0] : all.find((s) => s.version === Number(p.version));
      if (!sub) return null;
      return {
        step: sub.step, version: sub.version, note: sub.note || '', questions: sub.questions || [], submitted_at: sub.submitted_at || null,
        items: (sub.items || []).map((it) => ({ label: it.label, kind: it.kind, text: it.text ?? null, file: it.file ?? null })),
      };
    },
    'project.events': (p) => readEvents(root, needProject(p), { limit: Math.min(2000, Number(p?.limit) || 200) }),
    // The Assets panel (owner, 2026-11-05): everything made, every AI call's prompt and answer, what each setting reached.
    'project.files': (p) => projectAssets(root, needProject(p)),
    'project.file.read': (p) => readProjectFile(root, needProject(p), String(p?.path || '')),

    // Token usage (owner, 2026-10-18): every Claude run newest first, and one run's bars and what it pulled in.
    // voice: what ElevenLabs or this computer's voice used (src/voiceusage.mjs), beside the Claude runs
    'tokens.runs': async (p) => { const id = needProject(p); const pr = loadProject(root, id); return { ...(await tokenRuns(root, id, { running: pr.session?.running ? pr.session.id : null, limit: p?.limit })), voice: voiceUsage(projectPaths(root, id).work) }; },
    // The token counter (owner, 2026-11-02): Claude tokens and ElevenLabs credits, per day/project/stage/model, records.
    'usage.get': async (p) => { try { return await usageGet(root, { range: p?.range === undefined ? 'all' : p.range, project: p?.project ? String(p.project) : undefined }, { fetch: fetchFn }); } catch (e) { if (e?.code === 'bad_request') bad(e.message); throw e; } },
    'tokens.run': async (p) => {
      const id = needProject(p);
      const pr = loadProject(root, id);
      if (!p?.run) bad('tokens.run needs a run');
      return await tokenRun(root, id, String(p.run), { running: pr.session?.running ? pr.session.id : null, bars: p?.bars, pulled: p?.pulled });
    },

    // ---- stages ----
    'stage.set': (p) => {
      // a v3 project names (and keys) its own stages: Look, Stills, Motion, Sound, Artcraft
      const set0 = (() => { const pid = p?.project ? String(p.project) : projectId(); try { return pid ? stageSet(projectPipeline(root, pid)) : undefined; } catch { return undefined; } })();
      const NAMES = set0?.names || STAGE_NAMES;
      const stage = stageIndex(Number.isInteger(p?.stage) ? p.stage : p?.key, set0);
      if (stage < 0) bad('stage must be 0-7 or a stage key');
      const from = stageIndex(p?.from, set0);
      let out = {};
      // the tab's own project (p.project); only the service's open project moves state.stage
      const id = p?.project ? String(p.project) : projectId();
      const primary = id === projectId();
      const before = primary ? state.stage : (() => { try { return mfxView(loadProject(root, id)).stage ?? 0; } catch { bad(`no project ${id}`); } })();
      if (p?.done === true && from >= 0) {
        if (id) {
          out = stageDone(root, id, from);
          // Leaving Music: the app builds the edit (Edit the video) or renders straight away (Get the video).
          if (from === STAGE_MUSIC && stage >= STAGE_EDIT) out.handover = handOverToApp(root, id, stage === STAGE_RENDER ? 'get' : 'edit');
          chatRow(id, { role: 'action', text: `Next: ${NAMES[stage]} (${NAMES[from]} kept as it is)` });
        } else state.stages[from] = { kind: 'done' };
      }
      if (id && stage !== before) chatRow(id, { role: 'stage', text: NAMES[stage], stage });
      if (primary) state.stage = stage;
      if (id) saveLastStage(root, id, stage);
      status(true);
      return { stage, key: STAGES[stage], ...out };
    },
    'stage.status': (p) => stageStatuses(root, needProject(p)),
    // no local models any more: the app's monitor gets the same "off" answer it always handled
    'models.status': async () => ({ wanted: null, why: null, models: [], others: [], gpu: null, off: true }),
    'stage.remakes': (p) => ({ remade: remakesIf(root, needProject(p), p?.stage ?? p?.key) }),
    'stage.reopen': (p) => { if (!String(p?.text || '').trim()) bad('say what to change'); const r = reopenStage(root, needProject(p), p?.stage ?? p?.key, p.text); runner?.wake(); poke(); return r; },
    'stage.handover': (p) => { const how = p?.how === 'get' ? 'get' : p?.how === 'edit' ? 'edit' : bad('how: edit or get'); const r = handOverToApp(root, needProject(p), how); poke(); return r; },

    // ---- presets (doc 31) ----
    'voices.list': () => voicesList(root),
    'presets.list': () => ({ ...listPresets(root), briefs: listBriefPresets(root) }),
    'presets.get': (p) => getPreset(root, String(p?.slug || bad('presets.get needs a slug'))),
    'presets.save': (p) => (p?.brief ? asBad(() => saveBriefPreset(root, p)) : savePresetFull(root, p || {})),
    'presets.delete': (p) => (p?.kind === 'brief' ? asBad(() => deleteBriefPreset(root, String(p?.slug || bad('presets.delete needs a slug')))) : deletePreset(root, String(p?.slug || bad('presets.delete needs a slug')))),

    // ---- New project brief (plan 52, docs/service-protocol.md "New project brief") ----
    'brief.schema': () => schemaView(),
    'brief.draft.list': () => ({ drafts: listDrafts(root) }),
    'brief.draft.get': (p) => ({ draft: asBad(() => getDraft(root, p?.draft)) }),
    'brief.draft.save': (p) => { const r = asBad(() => saveBriefDraft(root, { draft: p?.draft, brief: p?.brief })); emit('brief.draft.saved', { draft: r.draft, saved_at: r.saved_at }); return r; },
    'brief.draft.delete': (p) => asBad(() => deleteDraft(root, String(p?.draft || bad('brief.draft.delete needs a draft')))),
    'sources.add': (p) => asBad(() => addSource(root, { draft: p?.draft, url: p?.url, path: p?.path, name: p?.name }, { fetch: fetchFn === globalThis.fetch ? undefined : fetchFn, onChange: (d) => emit('sources.changed', d) })),
    'sources.list': (p) => ({ draft: String(p?.draft || bad('sources.list needs a draft')), sources: asBad(() => listSources(root, p.draft)) }),
    'sources.remove': (p) => { const r = asBad(() => removeSource(root, String(p?.draft || bad('sources.remove needs a draft')), String(p?.id || bad('sources.remove needs an id')))); emit('sources.changed', { draft: p.draft, removed: r.removed }); return r; },
    'brief.summary': (p) => summarize(p?.brief, p?.draft ? asBad(() => listSources(root, p.draft)) : [], { wpm: speechPace(root, { voiceId: (() => { try { return voiceConfig(root).elevenlabs.voice_id; } catch { return null; } })() }).wpm }),
    'brief.improve': (p) => improveBrief(root, p?.brief, p?.draft ? asBad(() => listSources(root, p.draft)) : []),
    // speaker + model: the Voice stage says what makes the voice (owner, 2026-10-19: "if it's being rendered locally, if it's being rendered on 11 labs")
    'voice.list': () => { const v = voiceOverview(root); return { engine: v.engine, voice: v.voice ?? null, speaker: v.engine === 'elevenlabs' ? v.elevenlabs.voice_name : null, model: v.engine === 'elevenlabs' ? v.elevenlabs.model_id : null, engines: [...VOICE_ENGINES], presets: [], elevenlabs_key: v.elevenlabs_key, needs_key: v.needs_key }; },
    // Settings › Mortiflix › Narration: which engine narrates new lines (ElevenLabs, your own voice, or none; no local voice)
    'voice.set': (p) => {
      const engine = String(p?.engine || '');
      if (!VOICE_ENGINES.includes(engine)) bad(`engine must be ${VOICE_ENGINES.join(', ')}`);
      saveVoice(root, { engine });
      return handlers['voice.list']();
    },

    // ---- assets (doc 32) ----
    'assets.list': (p) => listAssets(root, needProject(p)),
    'assets.add': (p) => { const id = needProject(p); const list = cleanAssetList(p); if (!list.length) bad('assets.add needs paths'); copyAssets(id, list); return { queued: list.length }; },
    'assets.update': (p) => { const id = needProject(p); const a = updateAsset(root, id, assetId(p?.asset), { use: p.use, where: p.where, note: p.note }); poke(); return { asset: a }; },
    'assets.replace': (p) => {
      const id = needProject(p);
      const aid = assetId(p?.asset);
      if (!p?.path) bad('assets.replace needs a path');
      replaceAsset(root, id, aid, { path: String(p.path), onProgress: (pr) => emit('assets.progress', { project: id, ...pr }) })
        .then((asset) => { emit('assets.added', { project: id, asset, replaced: true }); chatRow(id, { role: 'action', text: `Replaced ${asset.id} with ${asset.name} (v${asset.version}; the old one is kept)` }); if (asset.kind === 'audio' && asset.use === 'reference') hearAsset(id, asset).catch(() => {}); })
        .catch((e) => emit('assets.failed', { project: id, asset: aid, message: e.message }));
      return { queued: 1 };
    },
    // Hear any song asset again (or one that wasn't marked "for reference"): tempo, key and chords.
    'assets.hear': async (p) => {
      const id = needProject(p);
      const a = listAssets(root, id).yours.find((x) => x.id === assetId(p?.asset)) || bad(`no asset ${p?.asset}`);
      if (a.kind !== 'audio') bad(`${a.name} isn't a song (audio) file`);
      return { asset: await hearAsset(id, a) };
    },
    'assets.remove': (p) => { const id = needProject(p); const a = removeAsset(root, id, assetId(p?.asset)); chatRow(id, { role: 'action', text: `Removed ${a.name} (${a.id}); the file is kept` }); return { asset: a }; },
    // Drag an asset onto a piece: it's used there, and (fix, default true) the AI is asked to put it in.
    'assets.use': (p) => {
      const id = needProject(p);
      const aid = assetId(p?.asset);
      const node = nodeId(p?.node);
      const a = useAsset(root, id, aid, node, { how: p.how, remove: Boolean(p.remove) });
      let edit = null;
      if (!p.remove && p.fix !== false) {
        try { edit = nodeAction(root, id, node, { action: 'fix', text: `Use the owner's asset ${a.id} (${a.file}) in this piece${p.how ? `: ${String(p.how).slice(0, 300)}` : ''}.` }).edit; } catch (e) { if (!/no piece/.test(e.message)) throw e; }
      }
      chatRow(id, { role: 'action', text: p.remove ? `${a.name} no longer used in ${node.toUpperCase()}` : `Use ${a.name} in ${node.toUpperCase()}${edit ? ` (${edit.id})` : ''}`, refs: [node], ...(edit ? { edit: edit.id } : {}) });
      runner?.wake();
      poke();
      return { asset: a, edit };
    },

    // ---- music theme and cues (doc 33) ----
    // paths in results are absolute: a session writes its theme samples' WAVs relative to its working folder
    'music.theme.get': (p) => {
      const id = needProject(p);
      const t = loadTheme(root, id);
      const work = projectPaths(root, id).work;
      if (t?.samples) t.samples = t.samples.map((x) => (x?.wav && !isAbsolute(x.wav) ? { ...x, wav: join(work, x.wav) } : x));
      return { theme: t };
    },
    'music.theme.set': (p) => { const id = needProject(p); const t = saveTheme(root, id, { ...(p?.theme || bad('music.theme.set needs a theme')), picked_by: 'you' }); chatRow(id, { role: 'action', text: `Music theme: ${[t.genre, ...t.mood].filter(Boolean).join(', ') || 'changed'}` }); poke(); return { theme: t }; },
    // Before a project exists (New project › Music › Choose…) pass no project: the demo makes samples in the studio.
    'music.theme.samples': async (p) => themeSamples(root, p?.project || projectId() || null, p?.theme || {}),
    'music.theme.use': (p) => {
      const id = needProject(p);
      const t = loadTheme(root, id) || bad('no theme yet');
      const sample = t.samples?.find((s) => s.id === p?.sample) || bad(`no theme sample ${p?.sample}`);
      const before = t.using;
      t.using = p.sample;
      const theme = saveTheme(root, id, t);
      // a theme picked after the music is written remakes the music in it (a Fix on the score; versions kept). Run 2:
      // the pick changed nothing you could hear
      const music = canvasView(root, id).nodes.music;
      let edit = null;
      if (before !== p.sample && music?.versions?.length) {
        edit = nodeAction(root, id, 'music', { action: 'fix', text: `The owner picked the music theme "${sample.name}" (music/theme.json, using ${sample.id}): rewrite the score in it, keeping the cue timing and the mix under the voice.` }).edit;
        runner?.wake();
      }
      chatRow(id, { role: 'action', text: `Music theme: ${sample.name}${edit ? ' · remaking the music in it' : ''}`, ...(edit ? { edit: edit.id, refs: ['music'] } : {}) });
      poke();
      return { theme, edit };
    },
    'music.theme.check': (p) => ({ theme: cleanTheme(p?.theme || {}) }),
    'music.cues': (p) => graph.voiceMusicView(root, needProject(p)).cues,
    'music.score': (p) => musicScore(root, needProject(p)),
    // A cue's feel, energy or harmonic tension: before the score it changes the plan; once scored it's a Fix on that cue (only it changes).
    'music.cue.set': (p) => {
      const id = needProject(p);
      const cue = String(p?.cue || '');
      if (!/^m\d{2,3}$/.test(cue)) bad('cue must be an id like m01');
      const g = canvasView(root, id);
      if (g.nodes[cue] && !g.nodes[cue].missing) {
        const words = [p.feel ? `Feel: ${String(p.feel).slice(0, 300)}` : null, p.energy ? `energy ${Number(p.energy)} of 5` : null,
          Number.isFinite(Number(p.tension)) && p.tension !== null && p.tension !== '' ? `harmonic tension ${Math.round(Math.min(1, Math.max(0, Number(p.tension))) * 10) / 10} (0 smooth triads … 1 rough: 9ths, 13ths, altered chords)` : null,
          p.text ? String(p.text).slice(0, 2000) : null].filter(Boolean).join('; ');
        if (!words) bad('say what to change');
        const r = nodeAction(root, id, cue, { action: 'fix', text: words, bars: p.bars ?? null, part: p.part ?? null });
        chatRow(id, { role: 'action', text: actionText('fix', g.nodes[cue].label, words), edit: r.edit.id, refs: [cue] });
        runner?.wake();
        poke();
        return { edit: r.edit };
      }
      return { plan: setCuePlan(root, id, cue, { feel: p.feel, energy: p.energy, tension: p.tension }) };
    },

    // ---- voice & music stage (doc 34) ----
    'voicemusic.view': (p) => graph.voiceMusicView(root, needProject(p)),
    'audio.peaks': async (p) => { try { return await audioPeaks(root, p); } catch (e) { bad(e.message); } },
    'voice.lines': (p) => graph.voiceMusicView(root, needProject(p)).voice,
    'mix.set': (p) => { const id = needProject(p); const r = graph.setMix(root, id, nodeId(p?.node), p || {}); if (r.edit) runner?.wake(); poke(); return r; },
    'voice.line.words': (p) => {
      const id = needProject(p);
      const line = nodeId(p?.line, 'line');
      const text = String(p?.text || '').trim() || bad('the new words are empty');
      const gate = paidTakeGate(id, line, text, p);
      if (gate) return gate;
      const r = nodeAction(root, id, line, { action: 'fix', text: `Change the words to: "${text.slice(0, 2000)}". Write them to voice/lines.json and the script beat, then make a new take.` });
      chatRow(id, { role: 'action', text: `Remake line ${line}: "${text.slice(0, 200)}"`, edit: r.edit.id, refs: [line] });
      runner?.routeTakes?.(id).catch((e) => console.error(`route takes: ${e.message}`)); // at once, not behind a session
      runner?.wake();
      return { edit: r.edit };
    },
    // ---- stage 2 Look: the looks to pick from (the Look panel + the chat's looks card) ----
    'look.get': (p) => lookView(root, needProject(p)),
    // the card list: counts and "brings" per pack; the file list of one pack is packs.files
    'packs.list': (p) => listAllPacks(root, p?.kind ? String(p.kind).slice(0, 40) : null).map(({ asset_files, ...rest }) => rest),
    'packs.files': (p) => { const k = String(p?.kind || bad('packs.files needs the kind')).slice(0, 40); const i = String(p?.id || bad('packs.files needs the id')).slice(0, 120); const pk = listAllPacks(root, k).find((x) => x.id === i); if (!pk) bad(`no ${k} pack "${i}"`); return { kind: k, id: i, files: pk.asset_files, counts: pk.counts, brings: pk.brings }; },
    'packs.kinds': () => packKinds(root),
    // "Add pack…": a folder or .zip becomes a pack (any files); a pack.json is written when there is none, with a SUGGESTED palette the owner confirms
    'packs.add': (p) => { const r = addPack(root, { path: p?.path, kind: p?.kind ? String(p.kind).slice(0, 40) : null, name: p?.name ? String(p.name).slice(0, 80) : null }); emit('packs.changed', { kind: r.kind, id: r.id }); return r; },
    'packs.confirm': (p) => { const r = confirmPack(root, { kind: String(p?.kind || 'style').slice(0, 40), id: String(p?.id || bad('packs.confirm needs the pack id')), palette: p?.palette, name: p?.name }); emit('packs.changed', { kind: r.kind, id: r.id }); return r; },
    // The project's asset pool (svc/pool.mjs): built from its style pack, asset packs and the default textures. `pool.get` builds it
    // first when nothing is built yet; assets are the pool rows without files' text, lines are what the AI is offered.
    'pool.get': (p) => { const id = needProject(p); let pool = readPool(root, id); if (!pool.assets?.length) pool = buildPool(root, id); return { project: id, packs: pool.packs, assets: pool.assets.map(({ text, layers, shapes, ...a }) => a), skipped: pool.skipped, lines: poolLines(pool) }; },
    'pool.build': (p) => { const id = needProject(p); const r = buildPool(root, id, { force: p?.force === true }); emit('pool.changed', { project: id }); return { project: id, rebuilt: r.rebuilt, assets: r.assets.length, skipped: r.skipped }; },
    'project.packs.assets': (p) => { const id = needProject(p); const assets = setAssetPacks(root, id, p?.assets); const r = buildPool(root, id); emit('pool.changed', { project: id }); return { project: id, assets, pool: { rebuilt: r.rebuilt, count: r.assets.length, skipped: r.skipped } }; },
    'transition.brief.get': (p) => getTransitionBrief(root, needProject(p)),
    'transition.brief.set': (p) => { const r = setTransitionBrief(root, needProject(p), p || {}); runner?.wake(); poke(); return r; },
    'motion.brief.get': (p) => getMotionBrief(root, needProject(p)),
    'motion.brief.set': (p) => { const r = setMotionBrief(root, needProject(p), p || {}); runner?.wake(); poke(); return r; },
    'look.packs': () => listPacks(root),
    'look.fonts': () => listFonts(),
    'look.brief.get': (p) => getBrief(root, needProject(p)),
    'look.brief.set': (p) => { const r = setBrief(root, needProject(p), p || {}); runner?.wake(); poke(); return r; },
    // Picking another look asks first when shots exist (no `confirm`: nothing changes, the answer lists what would be
    // remade); confirmed, the shots made in the old look are remade in the new one (a Fix each), one grey chat line.
    'look.use': (p) => {
      const id = needProject(p);
      const r = useLook(root, id, { frame: p?.frame, confirm: p?.confirm === true });
      if (r.changed) {
        const name = lookView(root, id).frames.find((f) => f.id === r.using)?.name || r.using;
        const n = r.remaking.length;
        chatRow(id, { role: 'action', text: `Look: now ${name}${n ? ` · remaking ${n === 1 ? '1 shot' : `${n} shots`} in it` : ''}`, refs: [r.using, ...r.remaking.map((x) => x.node)].slice(0, 40) });
        emit('look.changed', { project: id, using: r.using, from: r.from, remaking: r.remaking });
        if (n) runner?.wake();
        poke();
      }
      return r;
    },
    'look.more': (p) => {
      const id = needProject(p);
      const r = moreLooks(root, id, { count: p?.count === undefined ? 2 : Number(p.count), text: p?.text });
      chatRow(id, { role: 'action', text: `Making ${r.making.length === 1 ? '1 more look' : `${r.making.length} more looks`} to pick from`, refs: r.making.map((x) => x.node) });
      emit('look.changed', { project: id, making: r.making });
      runner?.wake();
      poke();
      return r;
    },
    // v3 stills: one per voice line (svc/stills.mjs). Drawing runs in the background; stills.changed tells the app.
    'stills.get': (p) => stillsView(root, needProject(p)),
    // the group flow (Claude draws a scene's stills at a time) when the backend is Claude; the template path (demo) keeps its own instant redraw
    'stills.ok': (p) => { const id = needProject(p); const groups = loadConfig(root).backend !== 'demo' && stillsMode(root, id) === 'groups'; const r = groups ? okStill(root, id, String(p?.line || '')) : okLine(root, id, String(p?.line || '')); if (vnotes.closeOnApp(root, id, r.line, 'still')) emit('videonotes.changed', { project: id }); emit('stills.changed', { project: id, line: r.line }); if (groups) { runner?.wake(); poke(); } return r; },
    'stills.send_anyway': (p) => { const id = needProject(p); const r = sendStillAnyway(root, id, String(p?.line || bad('needs the line'))); emit('stills.changed', { project: id, line: r.line }); poke(); return r; },
    'stills.retry': (p) => { const id = needProject(p); const r = retryStill(root, id, String(p?.line || bad('needs the line'))); emit('stills.changed', { project: id, line: r.line }); runner?.wake(); poke(); return r; },
    'stills.fix': async (p) => {
      const id = needProject(p); const line = String(p?.line || '');
      if (loadConfig(root).backend !== 'demo' && stillsMode(root, id) === 'groups') { // the group flow: the notes go as one fix, that still alone is drawn again
        const r = await fixStill(root, id, line, { text: opt(p?.text, 4000), ask: askFor(id) });
        if (vnotes.closeOnApp(root, id, line, 'still')) emit('videonotes.changed', { project: id });
        emit('stills.changed', { project: id, line }); emit('lessons.changed', { project: id }); runner?.wake(); poke();
        return r;
      }
      drawLine(root, id, line, { text: p?.text, key_word: p?.key_word }).then((d) => emit('stills.changed', { project: id, line, error: d.error || null }), (e) => emit('stills.changed', { project: id, line, error: e.message || String(e) }));
      emit('stills.changed', { project: id, line, drawing: true });
      return { line, drawing: true };
    },
    'stills.make': (p) => { const id = needProject(p); makeStills(root, id).then((r) => emit('stills.changed', { project: id, ...r }), (e) => emit('stills.changed', { project: id, error: e.message || String(e) })); return { making: true }; },
    // ---- the script, line by line (Script panel + the chat's script card) ----
    'script.get': (p) => { const id = needProject(p); return { ...scriptView(root, id), chosen_sec: chosenSec(root, id) }; },
    // The app's unsaved script changes, kept per project (null clears them); script.get hands them back.
    'script.draft': (p) => saveDraft(root, needProject(p), p?.draft),
    // Saves the owner's edits into the script (and the voice lines), then remakes only the pieces that used the
    // changed words: a Fix on each (the canvas's own path; versions kept). One grey chat line, one script.changed.
    'script.edit': (p) => {
      const id = needProject(p);
      const done = applyScriptEdits(root, id, p);
      const remade = [];
      for (const a of remakesFor(root, id, done)) {
        try {
          const r = nodeAction(root, id, a.node, { action: a.action, text: a.text });
          if (r.edit) remade.push({ node: a.node, kind: r.edit.kind, edit: r.edit.id });
        } catch (e) { console.error(`script.edit ${a.node}: ${e.message}`); }
      }
      const text = scriptActionText(done, remade);
      scriptLogged(root, id, text);
      chatRow(id, { role: 'action', text, refs: [...done.changed, ...done.added, ...remade.map((r) => r.node)].filter((x, i, l) => l.indexOf(x) === i).slice(0, 40) });
      const data = { project: id, beats: done.beats, changed: done.changed, added: done.added, keys: done.keys, deleted: done.deleted, restored: done.restored, renamed: done.renamed, remaking: remade };
      emit('script.changed', data);
      if (remade.length) runner?.wake();
      poke();
      return data;
    },
    'voice.line.take': (p) => {
      const id = needProject(p);
      const line = nodeId(p?.line, 'line');
      // a line never made is made by the voice step, under its own cost OK (P032): a "new take" here would pay its first read
      if (!existsSync(join(projectPaths(root, id).work, 'sound', 'voice', 'lines', `${line}.pcm`))) throw new UserError('this line is made by Make the voice (its cost OK)');
      const gate = paidTakeGate(id, line, p?.text || null, p);
      if (gate) return gate;
      const r = nodeAction(root, id, line, { action: 'fix', text: `New take of this line${p?.text ? `: ${String(p.text).slice(0, 500)}` : ''} (keep it inside its slot).` });
      chatRow(id, { role: 'action', text: `New take: ${line}`, edit: r.edit.id, refs: [line] });
      runner?.routeTakes?.(id).catch((e) => console.error(`route takes: ${e.message}`)); // at once, not behind a session
      runner?.wake();
      return { edit: r.edit };
    },
    // the whole voice: the cost of the changed lines first; with confirm the runner makes it
    // cost first for a step the runner would start by itself (src/svc/paidgate.mjs): what it costs, and the owner's OK
    'step.cost': (p) => {
      const id = needProject(p);
      const step = String(p?.step || 'voice');
      if (!PAID_STEPS.includes(step)) bad(`step must be ${PAID_STEPS.join(', ')}`);
      const e = stepEstimate(root, id, step, { session: true });
      const pr = loadProject(root, id);
      return { step, estimate_credits: e?.estimate_credits ?? 0, free: !e, ...(e?.characters != null ? { characters: e.characters, lines: e.lines } : {}), voice: step === 'voice' ? (e?.voice ?? voiceStepEstimate(root, id).voice) : null, confirmed: pr.cost_ok?.[step] ?? null, ok_now: okNow(root, id, step), ask_first: askFirst(root), waiting: pr.needs_you?.kind === 'cost_ok' && pr.needs_you.step === step };
    },
    'step.confirm_cost': (p) => {
      const id = needProject(p);
      const r = asBad(() => { try { return confirmCost(root, id, String(p?.step || '')); } catch (e) { if (e.code === 'bad') bad(e.message); throw e; } });
      chatRow(id, { role: 'action', text: `OK on the cost: ${r.step}, about ${r.credits ?? '?'} ElevenLabs credits` });
      // v3: the music has no step of its own (the voice step makes it): the OK makes the cues not made yet, now
      if (r.step === 'music' && musicExpected(root, id)) {
        r.making = true;
        Promise.resolve().then(() => handlers['music.make']({ project: id, confirm: true }))
          .catch((e) => { chatRow(id, { role: 'action', text: `The music stopped: ${e.message}` }); emit('music.changed', { project: id }); });
      }
      runner?.wake();
      poke();
      return r;
    },
    'voice.make': (p) => {
      const id = needProject(p);
      const e = voiceMakeEstimate(root, id);
      if (e.needs_confirm && p?.confirm !== true) return e;
      // the whole voice with confirm is the owner's OK on its cost too (the runner's cost-first gate)
      if (p?.confirm === true) { try { confirmCost(root, id, 'voice'); } catch (err) { if (err.code === 'credit_cap') throw err; /* no voice step: nothing to book */ } }
      runner?.wake();
      return { ...e, needs_confirm: false, confirmed: p?.confirm === true };
    },
    'voice.booth.status': (p) => boothStatus(root, needProject(p)),
    // Who has recorded before (the booth's "Who's recording?" list) and where their kept takes are collected.
    'voice.booth.speakers': () => ({ names: speakers(root), dir: voicesDir(root) }),
    // A recording (the app's own mic, or a file the owner picked) as a take; kept by default, so it plays at once.
    'voice.booth.import': async (p) => {
      const id = needProject(p);
      const line = String(p?.line || '');
      const file = String(p?.path || bad('voice.booth.import needs a path'));
      const wav = await toWav(file);
      const take = addTake(root, id, line, wav, { source: p?.source === 'booth' ? 'booth' : 'import', speaker: p?.speaker || null });
      const kept = p?.keep === false ? null : keepTake(root, id, line, take.take_no);
      chatRow(id, { role: 'action', text: `Recorded line ${line} (take ${take.take_no}${kept ? ', kept' : ''})`, refs: [line] });
      poke();
      return { take, kept: Boolean(kept) };
    },
    'voice.booth.keep': (p) => { const id = needProject(p); const t = keepTake(root, id, String(p?.line || ''), Number(p?.take)); poke(); return { take: t }; },

    // ---- lessons + notes + scene 1 first (v3, svc/lessons.mjs) ----
    'lessons.list': (p) => lessons.listLessons(root, p?.project || state.project?.id || null, ['all', 'project', 'both'].includes(p?.scope) ? p.scope : 'both'),
    'lessons.propose': async (p) => { const id = needProject(p); const r = await lessons.proposeLesson(root, id, { note: p?.note, node: p?.node ? String(p.node) : null, frame: p?.frame ?? null, ask: askFor(id) }); emit('lessons.changed', { project: id }); return r; },
    'lessons.approve': (p) => { const r = lessons.approveLesson(root, p?.project || state.project?.id || null, String(p?.id || bad('needs a lesson id')), p?.scope); emit('lessons.changed', {}); return r; },
    'lessons.edit': (p) => { const r = lessons.editLesson(root, p?.project || state.project?.id || null, String(p?.id || bad('needs a lesson id')), p); emit('lessons.changed', {}); return r; },
    'lessons.toggle': (p) => { const r = lessons.toggleLesson(root, p?.project || state.project?.id || null, String(p?.id || bad('needs a lesson id')), p?.on); emit('lessons.changed', {}); return r; },
    'lessons.restore': (p) => { const r = lessons.restoreLesson(root, String(p?.id || bad('needs a lesson id'))); emit('lessons.changed', {}); return r; },
    'lessons.delete': (p) => { const r = lessons.deleteLesson(root, p?.project || state.project?.id || null, String(p?.id || bad('needs a lesson id'))); emit('lessons.changed', {}); return r; },
    'lessons.import': (p) => lessons.importLearned(root, p?.path),
    'notes.save': async (p) => {
      const id = needProject(p);
      const r = await lessons.saveNote(root, id, p, { fix: (node, text) => handlers['node.edit']({ project: id, node, action: 'fix', text }), ask: askFor(id) });
      emit('lessons.changed', { project: id });
      return r;
    },
    'notes.send': (p) => {
      const id = needProject(p);
      const r = lessons.sendNotes(root, id, p?.node, { fix: (node, text) => handlers['node.edit']({ project: id, node, action: 'fix', text }) });
      if (vnotes.closeOnApp(root, id, String(p?.node || ''))) emit('videonotes.changed', { project: id });
      emit('lessons.changed', { project: id });
      return r;
    },
    'notes.delete': (p) => { const id = needProject(p); const r = lessons.deleteNote(root, id, String(p?.note || p?.id || bad('needs the note'))); emit('lessons.changed', { project: id }); return r; },
    'notes.list': (p) => lessons.listNotes(root, needProject(p), p?.node ? String(p.node) : null),
    // ---- style frames, rounds of 3 (svc/frames.mjs): the owner checks off EACH frame ----
    'frames.get': (p) => framesSvc.framesView(root, needProject(p)),
    'frames.ok': (p) => {
      const id = needProject(p);
      const r = framesSvc.okFrame(root, id, String(p?.frame || bad('needs the frame (sf01)')));
      if (vnotes.closeOnApp(root, id, r.approved, 'frame')) emit('videonotes.changed', { project: id });
      emit('frames.changed', { project: id, frame: r.approved }); emit('lessons.changed', { project: id });
      runner?.wake(); poke();
      return r;
    },
    'frames.fix': async (p) => {
      const id = needProject(p);
      const r = await framesSvc.fixFrame(root, id, String(p?.frame || bad('needs the frame (sf01)')), { text: opt(p?.text, 4000), ask: askFor(id) });
      if (vnotes.closeOnApp(root, id, r.fixing, 'frame')) emit('videonotes.changed', { project: id });
      emit('frames.changed', { project: id, frame: r.fixing }); emit('lessons.changed', { project: id });
      runner?.wake(); poke();
      return r;
    },
    'frames.send_anyway': (p) => { const id = needProject(p); const r = framesSvc.sendAnyway(root, id, String(p?.frame || bad('needs the frame (sf01)'))); emit('frames.changed', { project: id, frame: r.sent }); poke(); return r; },
    'frames.retry': (p) => { const id = needProject(p); const r = framesSvc.retryFrame(root, id, String(p?.frame || bad('needs the frame (sf01)'))); emit('frames.changed', { project: id, frame: r.retrying }); runner?.wake(); poke(); return r; },
    'frames.send_fixes': (p) => { const id = needProject(p); const r = framesSvc.sendFixesNow(root, id); emit('frames.changed', { project: id }); emit('lessons.changed', { project: id }); runner?.wake(); poke(); return r; },
    'frames.enough': (p) => { const id = needProject(p); const r = framesSvc.enoughFrames(root, id); emit('frames.changed', { project: id }); poke(); return r; },
    // Scenes one at a time (motion.first.* are the old names). The OK on a scene builds the NEXT scene only.
    'motion.scene.get': (p) => {
      const id = needProject(p);
      // the owner is on Motion with a scene to check: the next one is made meanwhile
      if (startAhead(root, id)) { runner?.wake(); poke(); }
      return lessons.sceneGet(root, id);
    },
    'motion.scene.approve': (p) => {
      const id = needProject(p);
      const r = approveScene(root, id, String(p?.beat || bad('needs the scene (beat)')), { remakeNext: p?.remake_next === true });
      if (vnotes.closeOnApp(root, id, String(p.beat))) emit('videonotes.changed', { project: id });
      // a scene made ahead reaches the tablet now that it is its turn
      if (r.next_ready && !r.remaking) vnotes.queueScenes(root, id, [r.next], { emit }).catch((e) => console.error(`video notes: ${e.message}`));
      emit('lessons.changed', { project: id });
      runner?.wake();
      poke();
      return r;
    },
    // Without confirm: {needs_confirm, warning} and nothing is built. With confirm: the rest in one go.
    'motion.scene.all': (p) => {
      const id = needProject(p);
      const r = allScenes(root, id, p?.confirm === true);
      runner?.wake();
      poke();
      return r;
    },
    // Video Notes (the owner's tablet), opt-in: the settings screen reads the status and turns it on.
    'videonotes.resend': async (p) => { const id = needProject(p); return vnotes.resendScene(root, id, String(p?.scene || bad('needs the scene (beat)')), { emit }); },
    'videonotes.status': async () => vnotes.videoNotesStatus(root),
    'videonotes.setup': async (p) => { vnotes.videoNotesSetup(root, p); const r = await vnotes.videoNotesStatus(root); emit('videonotes.changed', {}); return r; },
    'motion.first.get': (p) => lessons.firstGet(root, needProject(p)),
    'motion.first.approve': (p) => {
      const id = needProject(p);
      const first = lessons.sceneBeats(root, id)[0]?.id;
      if (p?.approved === false) return lessons.firstApprove(root, id, false);
      const r = approveScene(root, id, first || bad('no scenes yet'));
      runner?.wake();
      poke();
      return { ...lessons.firstGet(root, id), ...r };
    },

    // ---- node area (doc 35) ----
    'node.list': (p) => {
      const view = canvasView(root, needProject(p));
      return { nodes: Object.entries(view.nodes).map(([id, n]) => ({ ...n, id })), open_edits: view.open_edits };
    },
    'graph.get': (p) => graph.graphView(root, needProject(p)),
    // OK / Fix / Cut it (and clear) on one node: the canvas's own nodeAction. Every press is a grey line in the chat.
    'node.edit': (p) => {
      const action = String(p?.action || '').toLowerCase();
      if (!['ok', 'fix', 'cut', 'clear'].includes(action)) bad('action must be ok, fix, cut or clear');
      if (!p?.node) bad('node.edit needs a node');
      const id = needProject(p);
      const r = nodeAction(root, id, String(p.node), { action, text: p.text, bars: p.bars ?? null, part: p.part ?? null });
      const node = canvasView(root, id).nodes[String(p.node)];
      const label = node?.label || String(p.node);
      // an OK'd scene starts its voice at once (src/voiceonok.mjs)
      if (action === 'ok' && node?.kind === 'beat') voiceOnOk(root, id, String(p.node), onActivity);
      chatRow(id, { role: 'action', text: actionText(action, label, action === 'fix' ? p.text : null), refs: [String(p.node)], ...(r.edit ? { edit: r.edit.id } : {}) });
      if (r.edit) runner?.wake();
      poke();
      return r;
    },
    'node.move': (p) => graph.moveNodes(root, needProject(p), p?.positions),
    'node.reorder': (p) => { const id = needProject(p); const r = graph.reorder(root, id, p?.order); chatRow(id, { role: 'action', text: `New film order: ${r.film.map((s) => s.toUpperCase()).join(' › ')}` }); poke(); return r; },
    'node.pick': (p) => { const id = needProject(p); const r = graph.pickVersion(root, id, nodeId(p?.node), p?.v === null || p?.v === undefined ? null : Number(p.v)); chatRow(id, { role: 'action', text: `${String(p.node).toUpperCase()} plays v${r.plays}`, refs: [p.node] }); poke(); return r; },
    'node.duplicate': (p) => { const id = needProject(p); const r = graph.newShot(root, id, { op: 'duplicate', after: nodeId(p?.node), text: opt(p?.text) || '' }); chatRow(id, { role: 'action', text: `Duplicate ${String(p.node).toUpperCase()} as ${r.node.toUpperCase()}`, edit: r.edit.id, refs: [r.node] }); runner?.wake(); poke(); return r; },
    'node.insert': (p) => { const id = needProject(p); const r = graph.newShot(root, id, { op: 'insert', after: nodeId(p?.after, 'after'), text: opt(p?.text) || '' }); chatRow(id, { role: 'action', text: `New shot ${r.node.toUpperCase()} after ${String(p.after).toUpperCase()}: ${String(p.text).slice(0, 200)}`, edit: r.edit.id, refs: [r.node] }); runner?.wake(); poke(); return r; },
    'node.find': (p) => graph.findNodes(root, needProject(p), p?.query),

    // ---- loose preview (doc 36) ----
    'preview.plan': (p) => graph.previewPlan(root, needProject(p), { scope: ['all', 'from', 'shot', 'beat'].includes(p?.scope) ? p.scope : 'all', node: p?.node ? String(p.node) : null }),

    ...artcraftHandlers(root, { needProject }),

    // ---- into Edit (doc 38) ----
    'handoff.plan': async (p) => {
      const id = needProject(p);
      const plan = graph.handoffPlan(root, id);
      // subtitles that would cover the picture's own words go to the top (the first time reads the shots' video)
      const shots = plan.clips.filter((c) => c.kind === 'shot');
      try { plan.subtitles_moved = await placeSubtitles({ captions: plan.captions, shots, cacheDir: join(canvasPaths(root, id).dir, 'ink') }); } catch { /* placed at the bottom as before */ }
      return plan;
    },
    'handoff.done': (p) => { const id = needProject(p); const r = graph.saveHandoff(root, id, p?.map || p); chatRow(id, { role: 'stage', text: STAGE_NAMES[STAGE_EDIT], stage: STAGE_EDIT }); poke(); return r; },
    'handoff.get': (p) => ({ map: graph.loadHandoff(root, needProject(p)) }),
    'handoff.swaps': (p) => graph.handoffSwaps(root, needProject(p)),
    'handoff.swapped': (p) => graph.markSwapped(root, needProject(p), nodeId(p?.node), p?.version, { clip: p?.clip, item: p?.item }),

    // ---- smart options instead of chat (Redesign parts/95-smart-options.md) ----
    // + lan (home-network access, svc/lanaccess.mjs; the bridge listens to settings.changed and only lets this machine
    // change it) and paid (the daily credit cap, svc/paidgate.mjs)
    'settings.get': () => ({ ...readReviewSettings(root), lan: lanSettings(root), paid: capSettings(root) }),
    'settings.set': (p) => {
      asBad(() => {
        saveReviewSettings(root, { options: p?.options, review: p?.review });
        if (p?.lan !== undefined) saveLan(root, p.lan?.enabled);
        if (p?.paid !== undefined) saveDailyCap(root, p.paid?.daily_cap ?? null);
      });
      const r = { ...readReviewSettings(root), lan: lanSettings(root), paid: capSettings(root) };
      emit('settings.changed', r);
      return r;
    },
    'options.get': (p) => asBad(() => options.get({ project: needProject(p), stage: String(p?.stage || ''), target: p?.target || null })),
    'options.run': (p) => { const id = needProject(p); const r = asBad(() => options.run({ project: id, id: p?.id, confirm: p?.confirm === true, confirm_cost: p?.confirm_cost === true }, { log: (row) => chatRow(id, row), wake: () => runner?.wake() })); poke(); return r; },

    // ---- chat (doc 37) ----
    'chat.history': (p) => chatHistory(root, needProject(p), { limit: p?.limit, before: p?.before || null }),
    'chat.context': (p) => { state.context = contextOf(p?.context); emit('chat.context', { context: state.context }); return { context: state.context }; },
    // A button press the app wants in the history as a grey line.
    'chat.action': (p) => chatRow(needProject(p), { role: 'action', text: String(p?.text || bad('chat.action needs text')).slice(0, 2000), context: p?.context, refs: Array.isArray(p?.refs) ? p.refs.map(String).filter((x) => NODE_ID.test(x)) : [] }),
    'chat.answer': (p) => {
      const id = needProject(p);
      const qid = String(p?.question || '');
      if (!loadProject(root, id).questions.some((x) => x.id === qid)) {
        // A submission's question (the brief's): the owner's answer is kept with the project, said in the chat (the AI
        // reads the chat) and logged. A step still waiting goes on once its last question is answered (policies).
        const sub = [...gates.submissions(root, id)].reverse().find((s) => (s.questions || []).some((q) => q?.id === qid));
        const q = sub?.questions.find((x) => x?.id === qid);
        if (!q) bad(`no question ${qid}`);
        const value = String(p?.value ?? '').trim().slice(0, 4000) || q.default;
        if (value === null || value === undefined) bad('this question needs an answer');
        updateProject(root, id, (pr) => { pr.mfx = pr.mfx || {}; pr.mfx.answers = { ...(pr.mfx.answers || {}), [qid]: { step: sub.step, text: String(q.text).slice(0, 400), answer: value, at: new Date().toISOString() } }; });
        projectEvent(root, id, { event: 'ANSWERED', actor: 'you', step: sub.step, details: `${String(q.text).slice(0, 120)} → ${value}` });
        chatRow(id, { role: 'action', text: `${q.text} → ${value}` });
        // The last answer approves the step now, for this project: the tick only looks at the service's open project,
        // which after a restart may be none or another tab's (2026-11-02: the ice brief stayed in review).
        policies(id);
        runner?.wake();
        poke();
        return { question: qid, answer: value, was_default: true };
      }
      const r = gates.answerQuestion(root, id, qid, p?.value ?? null);
      const q = loadProject(root, id).questions.find((x) => x.id === p.question);
      chatRow(id, { role: 'action', text: `${q?.text || p.question} → ${q?.answer ?? p.value}` });
      runner?.wake();
      poke();
      return r;
    },
    // The AI's own questions, then the answers given on a submission's questions (the brief's), so the chat's
    // cards show them after a restart too.
    'questions.list': (p) => {
      const pr = loadProject(root, needProject(p));
      const given = Object.entries(pr.mfx?.answers || {}).map(([id, a]) => ({ id, step: a.step, text: a.text, answer: a.answer, answered_at: a.at }));
      return [...pr.questions, ...given.filter((g) => !pr.questions.some((q) => q.id === g.id))];
    },
    // The service is the source of truth: the user's own message comes back as a chat.message too. In a node
    // context it becomes a Fix there; otherwise the user's own Claude Code answers (and may pick a move).
    'chat.send': (p) => {
      const text = String(p?.text ?? '').trim().slice(0, 20_000);
      if (!text) bad('say something');
      // the tab's own project first: the service's open project may be another tab's
      const id = p?.project ? String(p.project) : projectId();
      if (!id) {
        emit('chat.message', { role: 'user', text, at: new Date().toISOString() });
        emit('chat.message', { role: 'system', text: 'Open or make a project first: the chat talks about one video.', at: new Date().toISOString() });
        return { queued: true };
      }
      const context = p?.context === undefined ? state.context : contextOf(p.context);
      chatRow(id, { role: 'user', text, context: context !== 'video' ? context : undefined });
      const typed = typedMove(root, id, { text, context, confirm: p?.confirm === true });
      if (typed) {
        chatRow(id, typed.reply);
        if (typed.move) { runner?.wake(); poke(); }
        return { queued: true, move: typed.move || null };
      }
      emit('chat.typing', { on: true });
      quickReply(root, id, { text, context })
        .then((r) => {
          const done = applyMove(root, id, r.move);
          chatRow(id, { role: 'ai', text: r.reply, refs: r.move?.node ? [String(r.move.node)] : [], ...(context !== 'video' ? { context } : {}) });
          if (done?.row) chatRow(id, done.row);
          if (done?.edit) runner?.wake();
        })
        .catch((e) => chatRow(id, { role: 'system', text: `The AI couldn't answer: ${e.message}` }))
        .finally(() => { emit('chat.typing', { on: false }); poke(); });
      return { queued: true };
    },
    'activity.list': (p) => (activity.get(needProject(p)) || []).slice(-Math.min(300, Number(p?.limit) || 100)),

    // ---- render queue and export (doc 39) ----
    'render.list': (p) => { const id = p?.project || null; return queue.list().filter((j) => !id || j.project === id); },
    'render.add': (p) => queue.addExternal({ projectId: p?.project || projectId(), label: opt(p?.label, 120) || 'Export', kind: opt(p?.kind, 40) || 'export', pid: p?.pid }),
    'render.progress': (p) => queue.report(Number(p?.id), { done: Number(p?.done), total: Number(p?.total), phase: p?.phase || 'rendering', pid: p?.pid }),
    'render.finish': (p) => queue.finish(Number(p?.id), { ok: p?.ok === true, file: p?.file || null, error: p?.error || null }),
    'render.cancel': (p) => queue.cancel(Number(p?.id)),
    'export.target': (p) => exportTarget(root, needProject(p), { ext: p?.ext, name: p?.name, stems: Boolean(p?.stems), create: Boolean(p?.create) }),
    'export.done': (p) => { const id = needProject(p); const r = deliverFromApp(root, id, { file: p?.file, preset: opt(p?.preset, 120) || null, timeline_rev: p?.timeline_rev ?? null }); poke(); return r; },
    'publish.plan': (p) => postPlan(root, needProject(p), p || {}),
    'publish.send': async (p) => postSend(root, needProject(p), p || {}),

    // ---- setup (part 09) ----
    // The slow tool probes run in a child and are cached (svc/setup-cache.mjs); {refresh: true} is "Check again".
    'setup.status': async (p) => ({ ...setup.setupStatusLight(root), ...(await setupCache.get('heavy', { force: p?.refresh === true })) }),
    'setup.backend': (p) => { const r = setup.setBackend(root, p?.backend === undefined ? undefined : String(p.backend), p?.claudeBin); setupCache.invalidate(); return r; },
    'setup.done': (p) => setup.setupDone(root, p?.done !== false),
    // ---- Fix it (plan 30, owner decisions 2026-11-01: cases 1, 2 shown only on error, 3 app wins, 4 re-check then resume) ----
    'sync.check': (p) => sync.check(root, { project: p?.project ? String(p.project) : null, cache: setupCache }),
    'sync.fix': async (p) => {
      if (!sync.CASES.includes(p?.case)) bad(`not a Fix it case: ${JSON.stringify(p?.case)}. Cases: ${sync.CASES.join(', ')}`);
      if (p.case !== 'tools' && !p?.project && !state.project?.id) throw new ProtocolError('no_project', 'open or make a project first');
      const r = await sync.fix(root, { name: p?.case, project: p?.project ? String(p.project) : (state.project?.id || null), cache: setupCache, emit, chatRow, resume: () => { runner?.wake(); poke(); } });
      return r;
    },
    'videonotes.reconcile': (p) => { const id = needProject(p); const r = sync.reconcileTablet(root, id); if (r.closed) emit('videonotes.changed', { project: id }); return r; },
    'project.recheck': async (p) => { const id = needProject(p); const r = await sync.recheck(root, id, { cache: setupCache }); if (r.resumed) { runner?.wake(); poke(); } return r; },
    'setup.claude.test': async () => setup.claudeTest(root),
    'keys.list': () => setup.keysList(root),
    'keys.set': (p) => { const r = setup.keySet(root, String(p?.id || ''), p?.value ?? null); setupCache.invalidate(); return r; },
    'keys.remove': (p) => { const r = setup.keySet(root, String(p?.id || ''), null); setupCache.invalidate(); return r; },
    'keys.check': async (p) => setup.keyCheck(root, String(p?.id || '')),
    // ---- the installer's components (packaging): status, and installing skipped ones later ----
    'components.status': async (p) => ({ components: await setupCache.get('components', { force: p?.refresh === true }), installing }),
    'components.install': (p) => {
      if (installing) throw new ProtocolError('busy', `already installing ${installing.join(', ')}`);
      let ids;
      try { ids = parseComponents(Array.isArray(p?.ids) ? p.ids.join(',') : p?.ids ?? 'default'); } catch (e) { bad(e.message); }
      installing = ids;
      installComponents(root, ids, { onEvent: (e) => emit('components.progress', e) })
        .then((results) => { setupCache.invalidate(); emit('components.done', { results }); })
        .catch((e) => { setupCache.invalidate(); emit('components.done', { results: [], error: e.message }); })
        .finally(() => { installing = null; });
      return { started: ids };
    },
  };
  // Setup downloads and installs (part 09): setup.download / setup.install / setup.cancel, setup.progress events.
  Object.assign(handlers, setupHandlers({ root, ProtocolError, emit: (ev, d) => { if (ev === 'setup.progress' && d?.kind === 'install' && d.state === 'done') setupCache.invalidate(); emit(ev, d); } }));
  Object.assign(handlers, musicHandlers({ root, emit, ProtocolError, needProject, previous: handlers }));
  Object.assign(handlers, transcribeHandlers({ root, emit, needProject, bad }));
  Object.assign(handlers, sfxHandlers({ root, needProject, ProtocolError, poke }));
  Object.assign(handlers, finalHandlers({ root, needProject, queue, poke }));
  // a free timing edit (a line's pause) joins the voice again from its takes, debounced, never ElevenLabs
  // (svc/restitch.mjs); a voice older than its lines (an edit made before this existed) is joined when Voice & music reads
  for (const [type, after, reset] of [
    ['voice.line.set', (p, r) => r?.changed?.gap && !r.retake && !r.dry && !r.needs_confirm, true],
    ['voicemusic.view', (p) => voiceStale(projectPaths(root, needProject(p)).work), false],
  ]) {
    const h = handlers[type];
    handlers[type] = (p) => { const r = h(p); try { if (after(p, r)) restitchSoon(root, needProject(p), { emit, reset }); } catch { /* no project */ } return r; };
  }
  // the free Speed control (whole voice, ffmpeg atempo, pitch kept) and the Length against the length asked
  handlers['voice.speed.get'] = (p) => { const id = needProject(p); return voiceLength(projectPaths(root, id).work, chosenSec(root, id)); };
  handlers['voice.speed.set'] = (p) => {
    const id = needProject(p); const work = projectPaths(root, id).work;
    try { setVoiceSpeed(work, p?.speed); } catch (e) { throw new ProtocolError('bad_request', e.message); }
    restitchSoon(root, id, { emit });
    return { ...voiceLength(work, chosenSec(root, id)), joining: true };
  };

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send({ id: null, ok: false, error: { code: 'bad_request', message: 'a request is a JSON object' } });
    const { id = null, type, params = {} } = msg;
    const h = typeof type === 'string' && Object.hasOwn(handlers, type) ? handlers[type] : null;
    if (!h) return send({ id, ok: false, error: { code: 'unknown_type', message: `unknown type ${JSON.stringify(type)}` } });
    try {
      const result = await h(params && typeof params === 'object' && !Array.isArray(params) ? params : {});
      if (!FAST.has(type)) dirty = true; // a request that may have changed something: the next tick looks
      send({ id, ok: true, result: result ?? null });
    } catch (e) {
      // a refusal that names its own code (UserError with a string code, e.g. 'no_pipeline') keeps it; a system error's
      // code (ENOENT...) is not a protocol code: 'failed'
      const code = e instanceof ProtocolError || (e instanceof UserError && typeof e.code === 'string') ? e.code : 'failed';
      // A bug (not a refusal) goes to the log with its stack; the app gets the message either way.
      if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) console.error(e);
      send({ id, ok: false, error: { code, message: String(e.message || e).slice(0, 2000) } });
    }
  }

  // restart: a planned restart (the app closed our input, or service.restart): the sessions it stops go on by themselves
  async function close({ restart = false } = {}) {
    closed = true;
    offUsage();
    clearInterval(usagePoll);
    if (usageTimer) clearTimeout(usageTimer);
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    if (runner) { await runner.stop({ restart }); runner.release(); }
  }

  return { handle, handlers, state, status, close, poke, warm: () => setupCache.warm(), ticks, get runner() { return runner; }, get queue() { return queue; } };
}

// Any recording to a 48 kHz mono 16-bit WAV for the booth (ffmpeg for everything that isn't WAV already).
async function toWav(file) {
  const { existsSync, statSync, readFileSync: read } = await import('node:fs');
  if (!existsSync(file) || !statSync(file).isFile()) throw new UserError('no such recording');
  if (/\.wav$/i.test(file)) return read(file);
  const r = await runAsync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { maxBuffer: 200 * 1024 * 1024, encoding: 'buffer' });
  if (r.status !== 0) throw new UserError(`couldn't read that recording: ${String(r.stderr).trim().slice(-200)}`);
  return r.stdout;
}

// Run on stdin/stdout. Nothing but protocol lines goes to stdout: console.log goes to stderr.
// The studio's runner runs here unless MFX_SERVICE_NO_RUNNER=1.
export function runStdio({ input = process.stdin, output = process.stdout, root = studioRoot(), runner = process.env.MFX_SERVICE_NO_RUNNER !== '1' } = {}) {
  console.log = console.error;
  ensureStudio(root);
  // the app went away (EPIPE): stop writing and close quietly instead of crashing with an unhandled error
  let gone = false;
  output.on?.('error', (e) => { if (gone) return; gone = true; console.error(`mortiflix-service: app closed the pipe (${e.code || e.message})`); Promise.resolve(svc?.close?.()).finally(() => process.exit(0)); });
  const send = (obj) => { if (!gone) output.write(JSON.stringify(obj) + '\n'); };
  const svc = createService({ root, send, runner, exit: () => Promise.resolve(svc.close({ restart: true })).finally(() => process.exit(0)) });
  setTimeout(() => svc.warm(), 1500).unref(); // the tool probes run once, in a child, so the first setup.status is already answered
  let buf = '';
  let chain = Promise.resolve();
  const fast = new Set();
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 16 * 1024 * 1024 && !buf.includes('\n')) { buf = ''; console.error('mortiflix-service: dropped a line over 16 MB'); return; }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ id: null, ok: false, error: { code: 'bad_json', message: 'not JSON' } }); continue; }
      if (CONTROL.has(msg?.type)) {
        svc.handle(msg);
      } else if (FAST.has(msg?.type)) {
        const behind = chain;
        const job = Promise.race([behind, new Promise((r) => setTimeout(r, FAST_WAIT_MS))]).then(() => svc.handle(msg)).finally(() => fast.delete(job));
        fast.add(job);
      } else {
        // a write never overtakes a read sent before it (that read still answers with the state it asked about)
        const reads = [...fast];
        chain = chain.then(() => Promise.allSettled(reads)).then(() => svc.handle(msg));
      }
    }
  });
  // The app closed our stdin (it quit or restarts us): finish what is running and go.
  // a planned stop: the sessions it stops are picked up again by the next service (runner.acquire)
  input.on('end', () => Promise.all([chain, ...fast]).finally(() => svc.close({ restart: true }).finally(() => process.exit(0))));
  process.once('SIGTERM', () => { markRestart(root, svc.runner ? [...svc.runner.running.keys()] : []); Promise.resolve(svc.close({ restart: true })).finally(() => process.exit(0)); });
  return svc;
}
