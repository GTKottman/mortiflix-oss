// The bridge: the only channel between a session and the studio. While a session runs, the runner listens on a
// private Unix socket, or a named pipe on Windows (never a network port); `mfx` inside the session talks to it with a per-session token.
// Everything a session asks for goes through the gate rules in gates.mjs.
import { createServer } from 'node:http';
import { rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as gates from './gates.mjs';
import { projectPipeline, loadProject, update, now } from './projects.mjs';
import { appendTaste } from './torch.mjs';
import { syncCanvas, openEdits, finishEdit } from './canvas.mjs';
import { isInside, loadConfig } from './studio.mjs';
import * as songAi from './song-ai.mjs';
import { makeVersion } from './song-store.mjs';
import { ipcPath } from './platform.mjs';

export async function openBridge({ root, projectId, sessionId, workdir, renders, sessionEnv }) {
  const token = randomBytes(24).toString('hex');
  const socket = ipcPath(`mfx-${randomBytes(6).toString('hex')}`, { tmp: tmpdir() });
  const pipe = process.platform === 'win32'; // a named pipe goes away with its server: there's no file to remove
  const work = realpathSync(workdir);

  const commands = {
    'status': ({ key, mode, list }) => (list ? projectPipeline(root, projectId).status_lines : gates.status(root, projectId, key, mode)),
    'step-start': ({ step }) => gates.stepStart(root, projectId, step),
    'step-done': ({ step, checks }) => gates.stepDone(root, projectId, step, checks),
    'checks': ({ step }) => gates.stepChecks(root, projectId, step).map(({ id, title, how, applies_to }) => ({ id, title, how, applies_to })),
    'submit': ({ step, submission }) => gates.submit(root, projectId, step, submission),
    'ask': ({ step, text, default: def, choices }) => gates.ask(root, projectId, step, text, { default: def ?? null, choices: choices ?? null }),
    'feedback': ({ step }) => ({ reviews: gates.feedbackFor(root, projectId, step), questions: loadProject(root, projectId).questions }),
    'handoff': ({ text }) => gates.handoff(root, projectId, text),
    'taste': ({ text }) => { if (!String(text || '').trim()) throw new gates.GateError('empty'); appendTaste(root, text); return { ok: true }; },
    'log': ({ name, details }) => gates.log(root, projectId, name, details),
    'needs-you': ({ text }) => gates.needsYou(root, projectId, text),
    'propose-check': (a) => gates.proposeCheck(root, projectId, a),
    'files': () => loadProject(root, projectId).intake.files,
    'canvas-sync': () => { const g = syncCanvas(root, projectId); return { rev: g.rev, order: g.order, problems: g.problems }; },
    'edits': () => openEdits(root, projectId),
    'edit-done': ({ edit, note }) => finishEdit(root, projectId, edit, { ok: true, note }),
    'edit-fail': ({ edit, note }) => finishEdit(root, projectId, edit, { ok: false, note }),
    // the song (doc 26 §2): reads give the rev a write must be based on; writes are by: 'ai' (locks hold)
    'song': () => songAi.songSummary(root, projectId),
    'song-show': (a) => songAi.songShow(root, projectId, a),
    'song-strudel': (a) => songAi.songStrudel(root, projectId, a),
    'song-strudel-put': (a) => songAi.songWriteStrudel(root, projectId, a),
    'song-notes': (a) => songAi.songWriteNotes(root, projectId, a),
    'song-ops': (a) => songAi.songWriteOps(root, projectId, a),
    'song-import': () => songAi.songImport(root, projectId),
    'song-version': ({ why }) => makeVersion(root, projectId, { by: 'ai', why: String(why || '').slice(0, 300) }),
    'render': ({ label, argv, cwd }) => {
      const dir = cwd ? realpathSync(cwd) : work;
      if (!isInside(work, dir)) throw new gates.GateError('renders run inside the project folder');
      // A machine-wide render queue (if the studio has one) wraps the command; ours still decides how many run at once.
      const prefix = (loadConfig(root).renderPrefix || []).map((a) => a.replaceAll('{label}', `${projectId}: ${label || argv.join(' ')}`.slice(0, 120)));
      const job = renders.add({ projectId, sessionId, label, argv: [...prefix, ...argv], cwd: dir, env: { ...process.env, ...sessionEnv } });
      markRendering(root, projectId, renders);
      return job;
    },
    'render-stop': ({ id }) => {
      const v = renders.stop(Number(id), projectId);
      markRendering(root, projectId, renders);
      return v;
    },
    'render-wait': async ({ id, seconds }) => {
      const v = await renders.wait(id, projectId, Number(seconds) || 100);
      markRendering(root, projectId, renders);
      return v;
    },
  };

  const server = createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-mfx-token'] !== token) return reply(403, { error: 'bad token' });
    // A malformed %-escape throws: inside this callback that would end the service and every session in it.
    let name;
    try { name = decodeURIComponent((req.url || '/').slice(1)); } catch { return reply(400, { error: 'bad command name' }); }
    // only the commands above: a plain lookup would also find "constructor", "toString"... on the object's prototype
    const fn = Object.hasOwn(commands, name) ? commands[name] : null;
    if (!fn || req.method !== 'POST') return reply(404, { error: `unknown command ${name}` });
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (d) => { if (tooBig) return; body += d; if (body.length > 5_000_000) { tooBig = true; body = ''; } });
    req.on('error', () => { /* the session went away mid-request: nothing to answer */ });
    req.on('end', async () => {
      if (tooBig) return reply(413, { error: 'the request is over 5 MB' });
      try {
        const args = body ? JSON.parse(body) : {};
        reply(200, { ok: true, result: await fn(args) });
      } catch (e) {
        reply(e instanceof gates.GateError ? 422 : 500, { error: e.message });
      }
    });
  });
  if (!pipe && existsSync(socket)) rmSync(socket);
  await new Promise((ok, fail) => server.listen(socket, ok).on('error', fail));
  return {
    socket,
    token,
    env: { MFX_SOCKET: socket, MFX_TOKEN: token, MFX_PROJECT: projectId },
    close: () => new Promise((ok) => { server.close(() => ok()); server.closeAllConnections?.(); if (!pipe) rmSync(socket, { force: true }); }),
  };
}

// While a render is queued or running, the owner sees that instead of the session's last status line.
function markRendering(root, projectId, renders) {
  const active = renders.activeFor(projectId);
  update(root, projectId, (p) => {
    const running = active.find((r) => r.state === 'running');
    const waiting = active.find((r) => r.state === 'waiting');
    if (running) p.status = { key: '_render', text: `Rendering: ${running.label}`, mode: 'rendering', at: now() };
    else if (waiting) p.status = { key: '_render', text: `Waiting to render (${waiting.renders_ahead} ahead)`, mode: 'rendering', at: now() };
    else if (p.status?.key === '_render') p.status = null;
  });
}
