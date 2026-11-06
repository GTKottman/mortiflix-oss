// Strudel in a headless Chrome, driven over the DevTools protocol (no npm dependencies). One page evaluates the score
// exactly as the Strudel REPL does; from it we read the notes (haps) and render audio with Strudel's own offline
// renderer (renderPatternAudio, the REPL's Export). Setup installs Strudel (MFX_STRUDEL) and finds Chrome (MFX_CHROME).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';

// Chrome's profile (and the rendered WAV, downloaded into it) lives on disk, not in /tmp: /tmp is often RAM (tmpfs), and a
// 26 min render is a 300 MB WAV plus Chrome's caches. Each profile records its Chrome and the node process that owns it,
// so one left behind by a killed run (SIGKILL, `timeout`) is closed by the next start.
const PROFILES = process.env.MFX_STRUDEL_PROFILES || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mortiflix', 'strudel');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function sweepProfiles(dir = PROFILES) {
  let closed = 0;
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith('mfx-strudel-')); } catch { return closed; }
  for (const n of names) {
    const own = join(dir, n, 'owner.json');
    let o = null;
    try { o = JSON.parse(readFileSync(own, 'utf8')); } catch { /* no record yet */ }
    if (!o || alive(o.node)) continue;
    if (o.chrome && alive(o.chrome)) { try { process.kill(-o.chrome, 'SIGKILL'); } catch { try { process.kill(o.chrome, 'SIGKILL'); } catch { /* gone */ } } }
    try { rmSync(join(dir, n), { recursive: true, force: true }); closed++; } catch { /* next time */ }
  }
  return closed;
}

// Rename, or copy when the WAV and its place are on different disks (EXDEV).
function moveFile(from, to) {
  try { renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page: Strudel's web bundle, plus a `drum` control for General MIDI drum numbers on samples.
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import * as S from '/strudel/index.mjs';
const { initStrudel, renderPatternAudio } = S;
let repl = null;
async function load(code) {
  if (!repl) { repl = await initStrudel(); try { S.registerControl?.('drum'); } catch {} }
  repl.state.evalError = undefined;
  await repl.evaluate(code, false);
  repl.scheduler.stop();
  if (repl.state.evalError) throw new Error(String(repl.state.evalError.message || repl.state.evalError));
  if (!repl.state.pattern) throw new Error('the score made no pattern (nothing to play)');
  return repl.state.pattern;
}
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'function' ? undefined : x)));
window.mfxHaps = async (code, cycles) => {
  const pat = await load(code);
  const cps = repl.scheduler.cps;
  const haps = pat.queryArc(0, cycles, { _cps: cps }).filter((h) => h.hasOnset()).map((h) => ({
    begin: h.whole.begin.valueOf(), end: h.whole.end.valueOf(), value: plain(h.value),
    locations: (h.context?.locations || []).map((l) => l.start ?? l),
  }));
  return { cps, haps };
};
window.mfxRender = async (code, cycles, sampleRate, name, channel, from = 0, onsetsBefore = null) => {
  let pat = await load(code);
  if (channel) pat = pat.filterValues((v) => v && v.midichan === channel);
  // A section of a long score: only the notes that start before its end; the rest of the window is their ring-out.
  if (onsetsBefore !== null) pat = pat.filterHaps((h) => h.whole && h.whole.begin.valueOf() < onsetsBefore);
  await renderPatternAudio(pat, repl.scheduler.cps, from, cycles, sampleRate, 512, false, name);
  return { cps: repl.scheduler.cps };
};
window.mfxReady = true;
</script>`;

export class HeadlessStrudel {
  constructor({ strudel = process.env.MFX_STRUDEL, chrome = process.env.MFX_CHROME } = {}) {
    if (!strudel || !existsSync(join(strudel, 'node_modules', '@strudel', 'web', 'dist', 'index.mjs'))) {
      throw new Error('Strudel isn\'t installed in this studio (MFX_STRUDEL). The owner runs `mortiflix setup music`; until then, say so with `mfx needs-you`.');
    }
    if (!chrome || !existsSync(chrome)) throw new Error('No Chrome to render in (MFX_CHROME). The owner runs `mortiflix setup music`.');
    this.dist = join(strudel, 'node_modules', '@strudel', 'web', 'dist');
    this.chromePath = chrome;
  }

  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
      // the studio's local sample library (samples.mjs): a render never waits on a download
      if (url.pathname.startsWith('/samples/') && process.env.MFX_SAMPLES) {
        const rel = decodeURIComponent(url.pathname.slice('/samples/'.length));
        const f = join(process.env.MFX_SAMPLES, rel);
        if (rel.includes('..') || !existsSync(f)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': extname(f) === '.json' ? 'application/json' : 'audio/wav' });
        return res.end(readFileSync(f));
      }
      const rel = url.pathname.replace(/^\/strudel\//, '');
      const file = join(this.dist, rel);
      if (!url.pathname.startsWith('/strudel/') || rel.includes('..') || !existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': ['.mjs', '.js'].includes(extname(file)) ? 'text/javascript' : 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    await new Promise((ok) => this.server.listen(0, '127.0.0.1', ok));
    mkdirSync(PROFILES, { recursive: true });
    sweepProfiles();
    this.profile = mkdtempSync(join(PROFILES, 'mfx-strudel-'));
    this.downloads = join(this.profile, 'downloads');
    // However this process ends (process.exit in die(), an error, Ctrl+C, the render queue's SIGTERM), Chrome goes
    // with it and so does its profile.
    this.exitHook = () => this.closeNow();
    this.signalHook = (sig) => { this.closeNow(); process.exit(sig === 'SIGINT' ? 130 : 143); };
    process.once('exit', this.exitHook);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, this.signalHook);
    this.chrome = spawn(this.chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${this.profile}`,
      '--remote-debugging-port=0', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', detached: true });
    try { writeFileSync(join(this.profile, 'owner.json'), JSON.stringify({ node: process.pid, chrome: this.chrome.pid })); } catch { /* sweep skips it */ }
    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      const f = join(this.profile, 'DevToolsActivePort');
      if (existsSync(f)) port = Number(readFileSync(f, 'utf8').split('\n')[0]) || null;
    }
    if (!port) throw new Error(`Chrome didn't start (${this.chromePath})`);
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    this.browser = await connect(browser.webSocketDebuggerUrl);
    await this.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloads });
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    this.page = await connect(pages.find((t) => t.type === 'page').webSocketDebuggerUrl);
    this.errors = [];
    this.page.on('Runtime.exceptionThrown', (p) => this.errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    this.page.on('Runtime.consoleAPICalled', (p) => {
      const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ').replace(/%c/g, '').replace(/background-color:[^;]*;color:[^;]*;border-radius:[^ ]*/g, '').trim();
      if (p.type === 'error' || /\berror\b|not found|is not defined/i.test(text)) this.errors.push(text.slice(0, 400));
    });
    await this.page.send('Runtime.enable');
    await this.page.send('Page.enable');
    await this.load();
    return this;
  }

  // A fresh Strudel page. Strudel keeps each orbit's effects (reverb, delay) between renders, wired to the previous
  // render's audio context, so a second render with effects comes out silent: every render gets a new page.
  async load() {
    await this.page.send('Page.navigate', { url: `http://127.0.0.1:${this.server.address().port}/?${Date.now()}` });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      if ((await this.eval('window.mfxReady === true').catch(() => false)) === true) return;
    }
    throw new Error(`Strudel didn't load in Chrome: ${this.errors.join(' / ') || 'timed out'}`);
  }

  async eval(expression) {
    const r = await this.page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
    return r.result?.value;
  }

  // Every note that starts in [0, cycles): { cps, haps: [{ begin, end, value, locations }] } (times in cycles = bars).
  async haps(code, cycles) {
    this.errors = [];
    try { return await this.eval(`mfxHaps(${JSON.stringify(code)}, ${Number(cycles)})`); } catch (e) { throw new Error(scoreError(e, this.errors)); }
  }

  // Renders [0, cycles) to a 16-bit WAV at `out`. `channel` renders one part (its .midichan).
  // `from`/`onsetsBefore` (cycles): render [from, cycles) with only the notes that start before `onsetsBefore`.
  async render(code, cycles, out, { sampleRate = 48000, channel = 0, from = 0, onsetsBefore = null } = {}) {
    if (this.rendered) await this.load();
    this.rendered = true;
    this.errors = [];
    const name = `r${Date.now()}`;
    const before = onsetsBefore === null ? 'null' : Number(onsetsBefore);
    try { await this.eval(`mfxRender(${JSON.stringify(code)}, ${Number(cycles)}, ${Number(sampleRate)}, ${JSON.stringify(name)}, ${Number(channel) || 0}, ${Number(from) || 0}, ${before})`); }
    catch (e) { throw new Error(scoreError(e, this.errors)); }
    const want = join(this.downloads, `${name}.wav`);
    for (let i = 0; i < 1200; i++) {
      if (existsSync(want) && !readdirSync(this.downloads).some((f) => f.endsWith('.crdownload'))) { moveFile(want, out); return out; }
      await sleep(100);
    }
    throw new Error('the render finished but no audio file arrived');
  }

  async close() {
    try { this.page?.close(); this.browser?.close(); } catch { /* gone */ }
    this.server?.close();
    await sleep(200);
    this.closeNow();
  }

  // Synchronous, so it also runs from process.on('exit'): kill Chrome, remove the profile, drop the hooks.
  closeNow() {
    if (this.chrome && this.chrome.exitCode === null && this.chrome.signalCode === null) { try { process.kill(-this.chrome.pid, 'SIGKILL'); } catch { try { this.chrome.kill('SIGKILL'); } catch { /* gone */ } } }
    if (this.profile) { try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* swept next start */ } this.profile = null; }
    if (this.exitHook) { process.removeListener('exit', this.exitHook); this.exitHook = null; }
    if (this.signalHook) { for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(sig, this.signalHook); this.signalHook = null; }
  }
}

function scoreError(e, logged) {
  const extra = logged.filter((l) => l && !e.message.includes(l)).slice(0, 3);
  return `The score didn't evaluate: ${e.message}${extra.length ? ` (${extra.join(' / ')})` : ''}`;
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }); });
  let n = 0;
  const waiting = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); if (m.error) w.fail(new Error(m.error.message)); else w.ok(m.result); }
    else if (m.method && listeners.has(m.method)) for (const f of listeners.get(m.method)) f(m.params);
  });
  return {
    send: (method, params = {}) => new Promise((ok, fail) => { const id = ++n; waiting.set(id, { ok: (r) => ok(r), fail }); ws.send(JSON.stringify({ id, method, params })); }).then((result) => (method === 'Runtime.evaluate' ? result : result)),
    on: (method, f) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(f); },
    close: () => ws.close(),
  };
}
