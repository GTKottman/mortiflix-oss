// The web studio: your projects, the review room, settings, plus the runner (sessions start by themselves).
//
// Security, because a local web server can be reached by any page in your browser:
//   - it listens on 127.0.0.1 unless you choose another host; then a token is required (printed at start)
//   - the Host header must be one we serve (blocks DNS-rebinding)
//   - every change needs the X-Mortiflix header, which other sites can't send without CORS (blocks CSRF)
//   - media is served from the project records only, with a sandboxing CSP and nosniff
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { REPO, paths, loadConfig, saveConfig, readSecret, writeSecret, readJson, isInside, UserError } from '../studio.mjs';
import { listPipelines } from '../pipelines.mjs';
import { createProject, addIntakeFile, startProject, listProjects, loadProject, projectPaths, projectPipeline, readEvents, readJournal } from '../projects.mjs';
import * as gates from '../gates.mjs';
import { Runner, BACKENDS } from '../runner.mjs';
import * as voice from '../voice/index.mjs';
import * as keys from '../keys.mjs';
import * as setup from '../setup.mjs';
import * as booth from '../booth.mjs';
import * as music from '../music.mjs';
import { costText } from '../usage.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const APP_CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const MEDIA_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

export async function startServer(root, { port = 4646, host = '127.0.0.1', runner: withRunner = true, socketPath = null, quiet = false } = {}) {
  const loopback = LOOPBACK.includes(host);
  let token = null;
  if (!loopback && !socketPath) {
    token = readSecret(root, 'web_token') || randomBytes(18).toString('base64url');
    writeSecret(root, 'web_token', token);
  }
  const runner = new Runner(root, { log: quiet ? () => {} : (l) => console.log(l) });
  const installs = new Map(); // tool -> { state: running|done|failed, log: [], result, error }
  const clients = new Set();
  const broadcast = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  let changeTimer = null;
  const changed = () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => broadcast('change', {}), 120); };
  runner.on('change', changed);
  runner.on('activity', (a) => broadcast('activity', a));

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      const code = /^no (project|step|question|pipeline)/.test(e.message) ? 404 : e instanceof UserError || e instanceof BadRequest ? 400 : 500;
      if (!res.headersSent) send(res, code, { error: e.message });
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!socketPath && loopback && !LOOPBACK.includes(hostHeader)) return send(res, 421, { error: 'unknown host' });

    if (token) {
      const cookie = /(?:^|;\s*)mfx_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      const given = url.searchParams.get('token');
      if (given && same(given, token)) {
        res.writeHead(302, { 'set-cookie': `mfx_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, location: url.pathname });
        return res.end();
      }
      if (!cookie || !same(cookie, token)) return send(res, 401, { error: 'open the link printed by `mortiflix serve` (it carries the access token)' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-mortiflix'] !== '1') return send(res, 403, { error: 'missing X-Mortiflix header' });

    const p = url.pathname;
    let m;
    if (p === '/api/events') return events(req, res);
    if (p.startsWith('/api/')) return api(req, res, url);
    if ((m = p.match(/^\/files\/([a-z0-9-]+)\/(.+)$/))) return media(req, res, m[1], decodeURIComponent(m[2]), url.searchParams.has('download'));
    return staticFile(res, p);
  }

  function events(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }

  async function api(req, res, url) {
    const p = url.pathname.slice(4);
    const method = req.method;
    let m;
    const after = (out) => { changed(); runner.wake(); return send(res, 200, out ?? { ok: true }); };

    if (p === '/studio' && method === 'GET') return send(res, 200, studioInfo(root, runner));
    if (p === '/config' && method === 'PUT') {
      const body = await json(req);
      const allowed = ['backend', 'model', 'effort', 'sandbox', 'webTools', 'fallbacks', 'maxSessionMinutes', 'claudeBin'];
      const patch = {};
      for (const k of allowed) if (k in body) patch[k] = body[k];
      if (patch.backend !== undefined && !BACKENDS[patch.backend]) throw new BadRequest('unknown backend');
      if (patch.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(patch.effort)) throw new BadRequest('effort: low, medium, high, xhigh or max');
      if (patch.model === '') patch.model = null;
      if (patch.maxSessionMinutes !== undefined) patch.maxSessionMinutes = Math.min(1440, Math.max(5, Number(patch.maxSessionMinutes) || 240));
      saveConfig(root, patch);
      if ('api_key' in body) writeSecret(root, 'anthropic_api_key', body.api_key ? String(body.api_key).trim() : null);
      return after(studioInfo(root, runner));
    }
    if (p.startsWith('/voice')) return voiceApi(root, req, res, url, p, method, after);
    // Setup: what each part is for, where it stands, and installing a tool (one at a time, log kept for the page).
    if (p === '/setup' && method === 'GET') return send(res, 200, await setupInfo(root, installs));
    if (p === '/setup/music' && method === 'PUT') { setup.saveMusic(root, await json(req)); return after(await setupInfo(root, installs)); }
    if (p === '/setup/assets' && method === 'PUT') { setup.saveAssetSites(root, (await json(req)).sites); return after(await setupInfo(root, installs)); }
    if (p === '/setup/recordings' && method === 'PUT') { setup.browserHarnessRecordings(Boolean((await json(req)).enable)); return after(await setupInfo(root, installs)); }
    if (p === '/setup/blender' && method === 'POST') {
      if (!loopback) throw new BadRequest('Blender opens on the studio\'s own screen: use mortiflix blender there');
      return send(res, 200, { path: setup.openBlender(root) });
    }
    if ((m = p.match(/^\/setup\/install\/([a-z-]+)$/)) && method === 'POST') {
      const tool = m[1];
      if (!setup.TOOLS.includes(tool)) throw new BadRequest(`unknown tool (${setup.TOOLS.join(', ')})`);
      if ([...installs.values()].some((j) => j.state === 'running')) throw new BadRequest('another install is running: wait for it to finish');
      const job = { state: 'running', log: [], started_at: new Date().toISOString() };
      installs.set(tool, job);
      setup.installTool(root, tool, { log: (l) => { job.log.push(l); if (job.log.length > 400) job.log.splice(0, job.log.length - 400); } })
        .then((r) => { job.state = 'done'; job.result = r; }, (e) => { job.state = 'failed'; job.error = e.message; })
        .finally(() => changed());
      return send(res, 202, { tool, state: job.state });
    }
    // Keys: their status (never their values), and setting one (checked with a free call before it's saved).
    if (p === '/keys' && method === 'GET') return send(res, 200, keysInfo(root));
    if ((m = p.match(/^\/keys\/([A-Za-z][A-Za-z0-9_]*)$/)) && (method === 'PUT' || method === 'DELETE')) {
      const id = keys.KEYS[m[1]] ? m[1] : null;
      const value = method === 'PUT' ? String((await json(req)).value || '').trim() : '';
      if (method === 'PUT' && !value) throw new BadRequest('paste a key');
      let check = null;
      if (id && value) {
        check = await keys.verifyKey(root, id, value);
        if (check.ok === false) throw new BadRequest(check.detail);
        if (check.tier) voice.saveVoice(root, { elevenlabs: { tier: check.tier } });
      }
      if (id) keys.saveKey(root, id, value || null); else keys.setSessionKey(root, m[1], value || null);
      return after({ ...keysInfo(root), check });
    }
    if (p === '/pipelines' && method === 'GET') {
      return send(res, 200, listPipelines(root).map(({ dir, ...x }) => x));
    }
    if (p === '/checks' && method === 'GET') return send(res, 200, readJson(paths(root).checks));
    if ((m = p.match(/^\/checks\/([a-z0-9-]+)$/)) && method === 'POST') {
      const { approve } = await json(req);
      return after(gates.decideCheck(root, m[1], Boolean(approve)));
    }
    if (p === '/projects' && method === 'GET') return send(res, 200, listProjects(root).map((x) => summary(root, x)));
    if (p === '/projects' && method === 'POST') {
      const body = await json(req);
      const created = createProject(root, { pipeline: body.pipeline, title: body.title, answers: body.answers || {}, backend: BACKENDS[body.backend] ? body.backend : null });
      return after({ id: created.id });
    }
    if (!(m = p.match(/^\/projects\/([a-z0-9-]+)(\/.*)?$/))) return send(res, 404, { error: 'not found' });
    const id = m[1];
    const sub = m[2] || '';
    loadProject(root, id); // 404s early

    if (sub === '' && method === 'GET') return send(res, 200, detail(root, id, runner));
    if (sub === '/files' && method === 'POST') {
      const field = url.searchParams.get('field');
      const name = url.searchParams.get('name');
      const rel = await addIntakeFile(root, id, { field, name, stream: req });
      return after({ path: rel });
    }
    if (sub === '/start' && method === 'POST') {
      // Ask for the keys this project will need now, not halfway through it.
      const missing = keys.projectMissingKeys(root, id);
      if (missing.length) return send(res, 409, { error: keys.missingKeysText(missing, 'start it'), needs_keys: missing });
      return after(startProject(root, id) && { ok: true });
    }
    if (sub === '/pause' && method === 'POST') { gates.pause(root, id); runner.stopProject(id); return after(); }
    if (sub === '/resume' && method === 'POST') { gates.resume(root, id); return after(); }
    if (sub === '/cancel' && method === 'POST') { gates.cancel(root, id); runner.stopProject(id); return after(); }
    if ((m = sub.match(/^\/reviews\/([a-z0-9_-]+)\/(\d+)$/)) && method === 'POST') {
      return after(gates.respond(root, id, m[1], Number(m[2]), await json(req)));
    }
    if ((m = sub.match(/^\/questions\/([a-z0-9]+)$/)) && method === 'POST') {
      const { answer } = await json(req);
      return after(gates.answerQuestion(root, id, m[1], answer ?? null));
    }
    if (sub.startsWith('/booth')) return boothApi(req, res, id, sub, method, after);
    if (sub.startsWith('/music')) return musicApi(req, res, id, sub, method, after, url);
    return send(res, 404, { error: 'not found' });
  }

  // The recording booth (src/booth.mjs): the script, takes as raw WAV bodies, keeping a take, and "done", which
  // resumes the project when it was waiting for the recording.
  async function boothApi(req, res, id, sub, method, after) {
    let m;
    if (sub === '/booth' && method === 'GET') {
      const p = loadProject(root, id);
      return send(res, 200, { project: { id, title: p.title, state: p.state, needs_you: p.needs_you }, engine: voice.voiceConfig(root).engine, ...booth.boothStatus(root, id), advice: booth.FLAG_ADVICE });
    }
    if ((m = sub.match(/^\/booth\/lines\/([A-Za-z0-9-]{1,40})\/takes$/)) && method === 'POST') {
      const take = booth.addTake(root, id, m[1], await rawBody(req, booth.MAX_TAKE_BYTES));
      changed();
      return send(res, 200, { take });
    }
    if ((m = sub.match(/^\/booth\/lines\/([A-Za-z0-9-]{1,40})\/takes\/(\d+)\/keep$/)) && method === 'POST') {
      return after({ take: booth.keepTake(root, id, m[1], Number(m[2])) });
    }
    if ((m = sub.match(/^\/booth\/lines\/([A-Za-z0-9-]{1,40})\/takes\/(\d+)\/audio$/)) && method === 'GET') {
      const file = booth.takeFile(root, id, m[1], Number(m[2]));
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': statSync(file).size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return createReadStream(file).pipe(res);
    }
    if (sub === '/booth/done' && method === 'POST') {
      const st = booth.boothStatus(root, id);
      if (!st.lines) throw new BadRequest('there is no script to record yet');
      if (st.missing.length) return send(res, 409, { error: `${st.missing.length} line(s) still need a kept take: ${st.missing.join(', ')}`, missing: st.missing });
      const p = loadProject(root, id);
      if (p.state === 'paused') gates.resume(root, id);
      return after({ resumed: p.state === 'paused' });
    }
    return send(res, 404, { error: 'not found' });
  }

  // Music the owner finishes in their own DAW (src/music.mjs): where it stands, the MIDI pack as a zip, importing the
  // master (raw audio body; a paused project resumes when it was waiting for it), and playing the imported master.
  async function musicApi(req, res, id, sub, method, after, url) {
    if (sub === '/music' && method === 'GET') return send(res, 200, music.musicStatus(root, id));
    if (sub === '/music/midi.zip' && method === 'GET') {
      const zip = music.midiPack(root, id);
      const p = loadProject(root, id);
      const nice = `${p.title.replace(/[^\w .-]+/g, '').trim() || 'mortiflix'} - MIDI.zip`;
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length, 'content-disposition': `attachment; filename="${nice}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(zip);
    }
    if (sub === '/music/master' && method === 'POST') {
      const r = await music.importMaster(root, id, { buffer: await rawBody(req, music.MAX_MASTER_BYTES), name: url.searchParams.get('name') || 'master.wav' });
      if (!r.ok) return send(res, 422, { error: r.errors.join('; '), ...r });
      const p = loadProject(root, id);
      if (p.state === 'paused' && !p.needs_you?.by_you) gates.resume(root, id);
      return after({ ...r, resumed: p.state === 'paused' && !p.needs_you?.by_you });
    }
    if (sub === '/music/master' && method === 'GET') {
      const file = music.musicPaths(root, id).master;
      if (!existsSync(file)) return send(res, 404, { error: 'no master imported' });
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': statSync(file).size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: 'not found' });
  }

  // Files from a project's record (what was submitted, the deliverables). Range requests for video and audio.
  function media(req, res, id, rel, download) {
    // Only the submitted files: checked on the resolved path, so encoded ../ can't climb out of reviews/.
    const base = realpathSync(join(projectPaths(root, id).state, 'reviews'));
    const file = resolve(base, rel.replace(/^reviews\//, ''));
    if (!rel.startsWith('reviews/') || !isInside(base, file) || file === base || !existsSync(file)) return send(res, 404, { error: 'not found' });
    const real = realpathSync(file);
    if (!isInside(base, real)) return send(res, 404, { error: 'not found' });
    const st = statSync(real);
    const type = MIME[extname(real).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'content-security-policy': MEDIA_CSP, 'cache-control': 'private, max-age=3600' };
    if (download) {
      const p = loadProject(root, id);
      const nice = `${p.title.replace(/[^\w .-]+/g, '').trim() || 'mortiflix'} - ${basename(real).replace(/^\d+-/, '')}`;
      headers['content-disposition'] = `attachment; filename="${nice.replace(/"/g, '')}"`;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(real, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(real).pipe(res);
  }

  function staticFile(res, p) {
    const webRoot = join(REPO, 'web');
    const rel = p === '/' || !extname(p) ? 'index.html' : p.slice(1);
    const file = resolve(webRoot, rel);
    if (!isInside(webRoot, file) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-security-policy': APP_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': extname(file) === '.woff2' || extname(file) === '.png' ? 'public, max-age=86400' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  }

  await new Promise((ok, fail) => {
    server.once('error', fail);
    if (socketPath) server.listen(socketPath, ok); else server.listen(port, host, ok);
  });

  let loop = null;
  if (withRunner) {
    runner.acquire();
    loop = runner.loop({ watch: true });
  }
  const where = socketPath || `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}/`;
  if (!quiet) {
    console.log(`Mortiflix studio: ${token ? `${where}?token=${token}` : where}`);
    if (token) console.log('(not on localhost: the link carries an access token; keep it private)');
  }
  const close = async () => {
    for (const c of clients) c.end();
    if (withRunner) { await runner.stop(); await loop; runner.release(); }
    await new Promise((ok) => server.close(ok));
  };
  if (!socketPath && !quiet) {
    process.once('SIGINT', async () => { console.log('\nStopping…'); await close(); process.exit(0); });
    process.once('SIGTERM', async () => { await close(); process.exit(0); });
  }
  return { server, runner, close, url: where, token };
}

class BadRequest extends Error {}

// Narration setup: the engine, ElevenLabs (account, models, voices, Voice Library, dictionaries, a test line) and
// local Qwen3-TTS through ComfyUI. Calls to ElevenLabs happen only when the page asks.
async function voiceApi(root, req, res, url, p, method, after) {
  const q = (k) => url.searchParams.get(k) || undefined;
  const client = () => {
    const key = voice.elevenKey(root);
    if (!key) throw new BadRequest('connect an ElevenLabs API key first');
    return new voice.eleven.ElevenLabs({ key, server: voice.voiceConfig(root).elevenlabs.server });
  };
  const wrap = async (fn) => {
    try { return await fn(); } catch (e) {
      if (e instanceof BadRequest || e instanceof UserError) throw e;
      throw new BadRequest(e.status === 401 ? 'ElevenLabs refused the key (401): check it, or make a new one at elevenlabs.io › Developers › API keys' : e.message);
    }
  };
  if (p === '/voice' && method === 'GET') return send(res, 200, voice.voiceOverview(root));
  if (p === '/voice' && method === 'PUT') {
    const body = await json(req);
    if ('elevenlabs_key' in body) voice.setElevenKey(root, body.elevenlabs_key);
    try { voice.saveVoice(root, body); } catch (e) { throw new BadRequest(e.message); }
    return after(voice.voiceOverview(root));
  }
  if (p === '/voice/elevenlabs/account' && method === 'GET') {
    const account = await wrap(() => client().account());
    voice.saveVoice(root, { elevenlabs: { tier: account.tier } });
    return send(res, 200, account);
  }
  if (p === '/voice/elevenlabs/models' && method === 'GET') return send(res, 200, await wrap(() => client().models()));
  if (p === '/voice/elevenlabs/voices' && method === 'GET') return send(res, 200, await wrap(() => client().voices({ search: q('search'), page_token: q('page') })));
  if (p === '/voice/elevenlabs/library' && method === 'GET') {
    return send(res, 200, await wrap(() => client().library({ search: q('search'), gender: q('gender'), age: q('age'), accent: q('accent'), language: q('language'), use_cases: q('use_case') ? [q('use_case')] : undefined, page: Number(q('page') || 0) })));
  }
  if (p === '/voice/elevenlabs/library/add' && method === 'POST') {
    const { owner, voice_id: vid, name } = await json(req);
    return after(await wrap(() => client().addFromLibrary(owner, vid, String(name || 'Mortiflix voice').slice(0, 100))));
  }
  if (p === '/voice/elevenlabs/dictionaries' && method === 'GET') return send(res, 200, await wrap(() => client().dictionaries()));
  if (p === '/voice/elevenlabs/preview' && method === 'GET') {
    const target = q('url');
    if (!voice.eleven.previewAllowed(target)) throw new BadRequest('not an ElevenLabs preview');
    const r = await fetch(target);
    if (!r.ok) throw new BadRequest(`preview ${r.status}`);
    res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'audio/mpeg', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (p === '/voice/qwen/status' && method === 'GET') {
    const cfg = voice.voiceConfig(root).qwen;
    return send(res, 200, await new voice.qwen.ComfyUI({ url: q('url') || cfg.url }).status());
  }
  if (p === '/voice/sample' && method === 'POST') {
    const { engine, text } = await json(req);
    const line = String(text || '').trim().slice(0, 300) || 'This is how your narration will sound.';
    const cfg = voice.voiceConfig(root);
    if (engine === 'elevenlabs') {
      if (!cfg.elevenlabs.voice_id) throw new BadRequest('choose a voice first');
      const out = await wrap(() => client().sample(cfg.elevenlabs, line));
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-characters': String(out.characters), 'cache-control': 'no-store' });
      return res.end(out.audio);
    }
    if (engine === 'qwen') {
      const out = await wrap(() => new voice.qwen.ComfyUI({ url: cfg.qwen.url }).sample(cfg.qwen, line));
      res.writeHead(200, { 'content-type': out.format === 'wav' ? 'audio/wav' : out.format === 'mp3' ? 'audio/mpeg' : 'audio/flac', 'cache-control': 'no-store' });
      return res.end(out.audio);
    }
    throw new BadRequest('engine must be elevenlabs or qwen');
  }
  return send(res, 404, { error: 'not found' });
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// A raw request body (a recorded take), refused past `limit` bytes.
function rawBody(req, limit) {
  return new Promise((ok, fail) => {
    const parts = [];
    let n = 0;
    req.on('data', (d) => { n += d.length; if (n > limit) { fail(new BadRequest('too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

function json(req, limit = 2_000_000) {
  return new Promise((ok, fail) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; if (body.length > limit) { fail(new BadRequest('too large')); req.destroy(); } });
    req.on('end', () => { try { ok(body ? JSON.parse(body) : {}); } catch { fail(new BadRequest('bad JSON')); } });
    req.on('error', fail);
  });
}

async function setupInfo(root, installs) {
  const status = await setup.setupStatus(root);
  const jobs = Object.fromEntries([...installs].map(([k, j]) => [k, { state: j.state, log: j.log.slice(-60), error: j.error || null, problems: j.result?.problems || null }]));
  return { parts: setup.PARTS, status, tools: setup.TOOL_INFO, addons: setup.ADDONS.map(({ id, name, about, owner }) => ({ id, name, about, owner: Boolean(owner) })),
    recordings: setup.browserHarnessRecordings() || null, jobs };
}

function keysInfo(root) {
  return { keys: keys.keyStatus(root), other: keys.sessionKeyNames(root) };
}

function studioInfo(root, runner) {
  const config = loadConfig(root);
  const backends = {};
  for (const [name, b] of Object.entries(BACKENDS)) if (b.available) backends[name] = b.available(config, root);
  const checks = readJson(paths(root).checks);
  return {
    root,
    config: { backend: config.backend, model: config.model, effort: config.effort, sandbox: config.sandbox, webTools: config.webTools, fallbacks: config.fallbacks, maxSessionMinutes: config.maxSessionMinutes },
    backends,
    api_key_set: Boolean(readSecret(root, 'anthropic_api_key')),
    api_key_env: Boolean(process.env.ANTHROPIC_API_KEY),
    session_env: existsSync(paths(root).sessionEnv),
    runner: runner.current ? { project: runner.current.projectId, session: runner.current.sessionId } : null,
    checks_proposed: checks.proposed.length,
  };
}

function summary(root, p) {
  let steps = [];
  try { steps = gates.stepView(p, projectPipeline(root, p.id)); } catch { /* a broken pipeline still lists */ }
  const current = steps.find((s) => s.state === 'in_review') || steps.find((s) => ['working', 'changes', 'ready'].includes(s.state));
  return {
    id: p.id, title: p.title, pipeline: p.pipeline, state: p.state, status: p.status, needs_you: p.needs_you,
    working: Boolean(p.session?.running), created_at: p.created_at, updated_at: p.updated_at, delivered_at: p.delivered_at || null,
    in_review: steps.filter((s) => s.state === 'in_review').map((s) => ({ key: s.key, name: s.name, version: s.version })),
    open_questions: p.questions.filter((q) => !q.answered_at).length,
    current: current ? { key: current.key, name: current.name } : null,
    done: steps.filter((s) => ['approved', 'done'].includes(s.state)).length,
    total: steps.length,
  };
}

function detail(root, id, runner) {
  const p = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  let activity = runner.activity.get(id) || [];
  if (!activity.length) {
    // After a restart: the last session's activity from disk.
    const dir = projectPaths(root, id).sessions;
    const last = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.activity.jsonl')).sort().at(-1) : null;
    if (last) activity = readFileSync(join(dir, last), 'utf8').trim().split('\n').slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  return {
    project: { ...p, usage: { ...p.usage, cost_text: costText(p.usage) } },
    pipeline: { slug: pipeline.slug, name: pipeline.name, makes: pipeline.makes, intake: pipeline.intake },
    steps: gates.stepView(p, pipeline).map((s) => ({ ...s, checks: gates.stepChecks(root, id, s.key).map((c) => ({ id: c.id, title: c.title })) })),
    submissions: gates.submissions(root, id),
    events: readEvents(root, id, { limit: 200 }),
    activity,
    renders: runner.renders.activeFor(id),
    journal: readJournal(root, id, { tailChars: 4000 }),
  };
}
