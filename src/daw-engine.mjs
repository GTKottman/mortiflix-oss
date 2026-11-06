// The studio's side of the sound engine (doc 16 §4, §7): it starts mortiflix-engine, talks to it in JSON lines over the
// child's stdin / stdout (no network port), and keeps it alive. One engine per studio.
//   requests  {"id": 41, "cmd": "transport.play", "args": {...}}  →  {"id": 41, "ok": true, "result": ...} | {"id": 41, "ok": false, "error": "..."}
//   events    {"ev": "alive" | "clock" | "meters" | "xrun" | "device" | "plugin" | "log", ...}
// Supervision: the engine says "alive" every second; 5 s with no word and no answer to engine.ping → its PID is killed
// and it starts again (after 1 s, 2 s, then 5 s). Three crashes inside 60 s → it stays stopped, with its last log lines.
// Only the PID this supervisor started is ever killed.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';

// What the browser may ask the engine for (sessions reach it only through mfx, never directly).
export const BROWSER_COMMANDS = new Set(['engine.hello', 'device.list', 'device.set', 'transport.play', 'transport.stop', 'transport.seek', 'transport.loop',
  'clock.subscribe', 'meters.subscribe', 'audition.note', 'engine.tone']);

const LOG_MAX = 10 * 1024 * 1024;

export function createEngineSupervisor({
  bin, args = [], env = process.env, logFile = null, lastTouchFile = null,
  heartbeatMs = 5000, checkMs = 1000, backoffMs = [1000, 2000, 5000], maxCrashes = 3, crashWindowMs = 60_000,
  timeoutMs = 5000, restore = null,
} = {}) {
  const ev = new EventEmitter();
  let child = null;
  let pid = null;
  let state = 'stopped';          // stopped | starting | running | restarting | failed
  let nextId = 1;
  const pending = new Map();
  let lastWord = 0;
  let pingSent = 0;
  let timer = null;
  let crashes = [];
  let stopping = false;
  const tail = [];                // the last 20 lines of the engine's log
  let lastFailure = null;
  // Where the engine was, so a restarted one comes back the same (doc 16 §7): the device it had open, the song file,
  // the last heard position and whether it was playing.
  const place = { device: null, song: null, clock: false, seconds: 0, playing: false };
  const heard = (c) => { if (c && typeof c.seconds === 'number') { place.seconds = c.seconds; place.playing = !!c.playing; } };

  const setState = (s, extra = {}) => { state = s; ev.emit('state', { state: s, pid, ...extra }); };
  function log(line) {
    tail.push(line); if (tail.length > 20) tail.shift();
    if (!logFile) return;
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      if (existsSync(logFile) && statSync(logFile).size > LOG_MAX) truncateSync(logFile, 0);
      appendFileSync(logFile, `${line}\n`);
    } catch { /* the log never stops the engine */ }
  }

  function start() {
    if (child) return Promise.resolve();
    stopping = false;
    setState('starting');
    child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    pid = child.pid;
    lastWord = Date.now();
    pingSent = 0;
    const me = child;
    createInterface({ input: me.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return log(`(not a protocol line) ${line}`); }
      lastWord = Date.now();
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'the engine said no'));
        return;
      }
      if (msg.ev) {
        if (msg.ev === 'clock') heard(msg);
        if (msg.ev === 'log') log(`[${msg.level || 'info'}] ${msg.text}`);
        ev.emit('event', msg);
        ev.emit(msg.ev, msg);
      }
    });
    createInterface({ input: me.stderr }).on('line', (line) => log(line));
    // Node: a process that could not be spawned emits 'error' (not 'spawn'), and 'exit' may or may not follow. With no
    // pid it never ran: handled as an exit (child reset, pending calls refused, the usual restart and give-up), once.
    me.on('error', (e) => { log(`could not start: ${e.message}`); if (me.pid === undefined) onExit(me, null, null); });
    me.stdin.on('error', (e) => log(`could not write to the engine: ${e.message}`)); // EPIPE when it died: never a crash
    me.on('exit', (code, signal) => onExit(me, code, signal));
    clearInterval(timer);
    timer = setInterval(heartbeat, checkMs);
    return call('engine.hello', {}, { timeout: Math.max(timeoutMs, 10_000) }).then((hello) => {
      setState('running', { hello });
      return hello;
    });
  }

  function heartbeat() {
    if (!child || state === 'failed') return;
    const quiet = Date.now() - lastWord;
    if (quiet < heartbeatMs) { pingSent = 0; return; }
    if (!pingSent) {
      pingSent = Date.now();
      call('engine.ping', {}, { timeout: heartbeatMs }).catch(() => {});
      return;
    }
    if (Date.now() - pingSent >= heartbeatMs) {
      log(`no word from the engine for ${Math.round(quiet / 1000)} s: restarting it`);
      killOwn();
    }
  }

  // Kills the PID this supervisor started, and nothing else.
  function killOwn() {
    if (!child || !pid) return;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  function onExit(me, code, signal) {
    if (me !== child) return;
    child = null;
    clearInterval(timer);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('the sound engine stopped')); }
    pending.clear();
    if (stopping) { pid = null; return setState('stopped'); }
    // which plugin it was touching, when it went down
    let touching = null;
    try { if (lastTouchFile && existsSync(lastTouchFile)) touching = readFileSync(lastTouchFile, 'utf8').trim() || null; } catch { touching = null; }
    lastFailure = { code, signal, touching, at: new Date().toISOString() };
    log(`the engine stopped (${signal || `exit ${code}`})${touching ? ` while touching ${touching}` : ''}`);
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < crashWindowMs).concat(now);
    if (crashes.length >= maxCrashes) { pid = null; return setState('failed', { failure: lastFailure, log: [...tail] }); }
    const wait = backoffMs[Math.min(crashes.length - 1, backoffMs.length - 1)];
    setState('restarting', { failure: lastFailure, inMs: wait });
    setTimeout(async () => {
      if (stopping || child) return;
      try {
        await start();
        await comeBack();
        if (restore) await restore(api);
      } catch (e) { log(`restart failed: ${e.message}`); }
    }, wait);
  }

  function call(cmd, args = {}, { timeout = timeoutMs } = {}) {
    if (!child) return Promise.reject(new Error('the sound engine isn\'t running'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`the sound engine didn't answer ${cmd} within ${timeout / 1000} s`)); }, timeout);
      pending.set(id, { resolve, reject, timer: t });
      child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    }).then((result) => {
      if (cmd === 'device.set') place.device = args;
      if (cmd === 'song.load' || cmd === 'song.patch') { place.song = args.path || place.song; if (cmd === 'song.load') { place.seconds = Number(args.atSeconds) || 0; place.playing = false; } }
      if (cmd === 'clock.subscribe') place.clock = true;
      if (cmd.startsWith('transport.')) heard(result);
      return result;
    });
  }

  // After a restart: the same device, the song at the last heard position, the clock, and playing again if it was.
  async function comeBack() {
    const { device, song, clock, seconds, playing } = place;
    if (device) await call('device.set', device, { timeout: 15000 });
    if (song) await call('song.load', { path: song, atSeconds: seconds }, { timeout: 120000 });
    if (clock) await call('clock.subscribe', {});
    if (song && device && playing) await call('transport.play', {});
    log(`came back${song ? ` with ${song} at ${seconds.toFixed(3)} s${playing ? ', playing' : ''}` : ''}`);
  }

  // Asks it to quit, then kills its PID if it hasn't after `graceMs`.
  async function stop({ graceMs = 2000 } = {}) {
    stopping = true;
    clearInterval(timer);
    if (!child) { setState('stopped'); return; }
    const me = child;
    const gone = new Promise((r) => me.once('exit', r));
    call('engine.quit', {}, { timeout: graceMs }).catch(() => {});
    const t = setTimeout(() => { if (child === me) killOwn(); }, graceMs);
    await gone;
    clearTimeout(t);
  }

  // Start again after it gave up (the "Start again" button).
  function reset() { crashes = []; if (state === 'failed') return start(); return Promise.resolve(); }

  const api = {
    start, stop, call, reset, on: (name, fn) => { ev.on(name, fn); return () => ev.off(name, fn); },
    get state() { return state; }, get pid() { return pid; }, get log() { return [...tail]; }, get failure() { return lastFailure; }, get place() { return { ...place }; },
  };
  return api;
}

// The studio's one engine (started the first time the music needs it, stopped with the server).
const engines = new Map();
export function enginePaths(root) {
  const run = join(root, 'run', 'daw-engine');
  return { bin: join(root, 'tools', 'daw-engine', 'mortiflix-engine'), run, log: join(run, 'engine.log'), lastTouch: join(run, 'last-touch') };
}
export function engineFor(root, opts = {}) {
  if (engines.has(root)) return engines.get(root);
  const p = enginePaths(root);
  const e = createEngineSupervisor({ bin: opts.bin || process.env.MFX_DAW_ENGINE || p.bin, logFile: p.log, lastTouchFile: p.lastTouch, args: ['--serve'], ...opts });
  engines.set(root, e);
  return e;
}
export async function stopEngines() { await Promise.all([...engines.values()].map((e) => e.stop())); engines.clear(); }
