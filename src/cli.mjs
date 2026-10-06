// mortiflix: the command line. Everything the web UI does, in a terminal.
import { createInterface } from 'node:readline';
import { existsSync, createReadStream, statSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { studioRoot, ensureStudio, loadConfig, saveConfig, paths, readJson } from './studio.mjs';
import { listPipelines, findPipeline } from './pipelines.mjs';
import { createProject, addIntakeFile, startProject, listProjects, loadProject, projectPaths, projectPipeline, readEvents } from './projects.mjs';
import * as gates from './gates.mjs';
import { Runner, BACKENDS } from './runner.mjs';
import * as voice from './voice/index.mjs';
import * as keys from './keys.mjs';

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, acc: (s) => `\x1b[38;5;208m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m` }
  : { b: (s) => s, dim: (s) => s, acc: (s) => s, red: (s) => s, green: (s) => s };

const HELP = `${C.b('mortiflix')}: a motion design studio on your machine. Claude makes the video, you approve every stage.

  ${C.b('Getting started')}
  mortiflix init [--backend claude-code|anthropic-api|demo]   set up the studio (~/Mortiflix, or $MORTIFLIX_STUDIO)
  mortiflix keys                                               add or change your keys (Anthropic, ElevenLabs, others)
  mortiflix doctor                                             check the tools a pipeline needs
  mortiflix demo                                               a full walk-through with placeholder work (free)

  ${C.b('Making videos')}
  mortiflix pipelines                                          what the studio can make
  mortiflix new <pipeline> [--title "…"] [--set key=value]… [--file key=path]… [--backend demo]
  mortiflix run [--watch]                                      run sessions until everything waits on you
  mortiflix list                                               your projects
  mortiflix status <project>                                   steps, versions, the log
  mortiflix review [<project>]                                 review what's waiting (approve, notes, answers)
  mortiflix pause|resume|cancel <project>

  ${C.b('The web studio')}
  mortiflix serve [--port 4646] [--host 127.0.0.1]             the studio in your browser, with the runner

  ${C.b('Narration')}
  mortiflix voice                                              what narrates your videos, and what this machine can run
  mortiflix voice elevenlabs                                   set up ElevenLabs (key, voice, model)
  mortiflix voice local                                        set up Qwen3-TTS on your GPU through ComfyUI
  mortiflix voice none                                         no narration (on-screen text and music)
  mortiflix voice test ["a line to speak"]                     hear the current voice

  ${C.b('Settings')}
  mortiflix config [key [value]]                               show or change settings
  mortiflix keys set <anthropic|elevenlabs|NAME>               set one key (typed hidden, or piped on stdin)
  mortiflix keys remove <anthropic|elevenlabs|NAME>
  mortiflix checks [approve|reject <id>]                       the error checklist sessions proposed

  --studio <dir> works with every command.`;

function parse(argv) {
  const out = { _: [], set: [], file: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const v = inline !== undefined ? inline : (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    if (k === 'set' || k === 'file') out[k].push(v); else out[k] = v;
  }
  return out;
}

export async function run(argv = process.argv.slice(2)) {
  const a = parse(argv);
  const root = studioRoot(typeof a.studio === 'string' ? a.studio : undefined);
  const [cmd, ...rest] = a._;
  // `await` the command: a bare `return promise` inside try would let its rejection escape the catch.
  const dispatch = async () => {
    switch (cmd) {
      case 'init': return init(root, a);
      case 'keys': return keysCmd(root, rest);
      case 'doctor': return doctor(root);
      case 'demo': return demo(root);
      case 'pipelines': return pipelines(root);
      case 'new': return newProject(root, rest[0], a);
      case 'run': return runLoop(root, a);
      case 'list': case 'ls': return list(root);
      case 'status': return status(root, pick(root, rest[0]));
      case 'review': return review(root, rest[0]);
      case 'pause': gates.pause(root, pick(root, rest[0])); return console.log('Paused.');
      case 'resume': gates.resume(root, pick(root, rest[0])); return console.log('Resumed: it will run on the next `mortiflix run` (or right away under `serve`).');
      case 'cancel': gates.cancel(root, pick(root, rest[0])); return console.log('Cancelled.');
      case 'serve': return serve(root, a);
      case 'config': return config(root, rest);
      case 'checks': return checks(root, rest);
      case 'voice': return voiceCmd(root, rest);
      case undefined: case 'help': return console.log(HELP);
      default: throw new Error(`unknown command "${cmd}" (mortiflix help)`);
    }
  };
  try {
    await dispatch();
  } catch (e) {
    console.error(C.red(`✖ ${e.message}`));
    process.exitCode = 1;
  }
}

// Questions in the terminal. Lines are queued, so piped answers (scripts, tests) work as well as typing.
function prompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  return {
    question(q) {
      process.stdout.write(q);
      const echo = (l) => { if (!process.stdin.isTTY && l !== null) process.stdout.write(`${l}\n`); return l; };
      if (queue.length) return Promise.resolve(echo(queue.shift()));
      if (closed) throw new Error('input ended');
      return new Promise((ok, fail) => waiters.push((l) => (l === null ? fail(new Error('input ended')) : ok(echo(l)))));
    },
    close: () => rl.close(),
  };
}

function needStudio(root) {
  if (!existsSync(paths(root).config)) throw new Error(`no studio at ${root}: run \`mortiflix init\` first`);
}

// A project id, or a unique prefix of one, or (when there's only one) none at all.
function pick(root, given) {
  needStudio(root);
  const all = listProjects(root);
  if (!given) {
    const live = all.filter((p) => !['delivered', 'cancelled'].includes(p.state));
    if (live.length === 1) return live[0].id;
    if (!live.length && all.length === 1) return all[0].id;
    throw new Error('which project? (mortiflix list)');
  }
  const hits = all.filter((p) => p.id === given || p.id.startsWith(given) || p.id.includes(given));
  if (hits.length === 1) return hits[0].id;
  throw new Error(hits.length ? `"${given}" matches ${hits.length} projects: be more specific` : `no project "${given}"`);
}

function detectBackend(root) {
  const config = loadConfig(root);
  if (BACKENDS['claude-code'].available(config).ok) return 'claude-code';
  if (BACKENDS['anthropic-api'].available(config, root).ok) return 'anthropic-api';
  return 'demo';
}

async function init(root, a) {
  const fresh = !existsSync(paths(root).config);
  ensureStudio(root);
  const backend = typeof a.backend === 'string' ? a.backend : (fresh ? detectBackend(root) : loadConfig(root).backend);
  if (!BACKENDS[backend]) throw new Error('backend must be claude-code, anthropic-api or demo');
  saveConfig(root, { backend });
  console.log(`${C.green('✔')} Studio ready at ${C.b(root)}`);
  console.log(`  Backend: ${C.b(backend)} ${C.dim(BACKENDS[backend].available(loadConfig(root), root).detail)}`);
  if (backend === 'demo') console.log(C.dim('  (No Claude Code login or API key found: the demo backend makes placeholder work. Install Claude Code, or add an API key with `mortiflix keys`.)'));
  if (process.stdin.isTTY && !a.yes) {
    console.log(`\n  ${C.b('Keys')}: Mortiflix runs on your own accounts. Keys stay in this studio folder, readable by you alone.`);
    const go = (await prompterOnce(`  Add them now? ${C.dim('[Y/n]')} `)).trim().toLowerCase();
    if (!go.startsWith('n')) await keysWalk(root);
  } else console.log(`\n  ${C.b('Keys')}: ${C.b('mortiflix keys')} when you want an API backend or ElevenLabs narration.`);
  console.log(`\n  ${C.b('Narration')} (optional): ${voiceOffer()}`);
  console.log(`\n  Next: ${C.b('mortiflix demo')} for a free walk-through, or ${C.b('mortiflix serve')} to open the studio in your browser.`);
}

function doctor(root) {
  const config = existsSync(paths(root).config) ? loadConfig(root) : null;
  const row = (ok, name, detail) => console.log(`${ok ? C.green('✔') : C.red('✖')} ${name.padEnd(14)} ${C.dim(detail)}`);
  row(Number(process.versions.node.split('.')[0]) >= 20, 'node', process.version);
  row(Boolean(config), 'studio', config ? root : `none at ${root} (mortiflix init)`);
  for (const [name, b] of Object.entries(BACKENDS)) {
    if (!b.available) continue;
    const r = b.available(config || loadConfig(root), root);
    row(r.ok, name, `${r.detail}${config?.backend === name ? '  ← in use' : ''}`);
  }
  for (const [bin, why] of [['ffmpeg', 'renders, checks, the demo'], ['ffprobe', 'the final pass'], ['npx', 'Remotion']]) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    row(r.status === 0 || (bin === 'npx' && spawnSync('npx', ['--version']).status === 0), bin, why);
  }
  if (process.platform === 'linux') row(spawnSync('bwrap', ['--version']).status === 0, 'bwrap', `optional session sandbox (${config?.sandbox ? 'on' : 'off'})`);
  for (const k of keys.keyStatus(root)) {
    row(Boolean(k.source) || !k.in_use, k.id, k.source ? `${k.name}: ${k.source}${k.in_use ? '  ← in use' : ''}` : k.in_use ? `${k.name} missing: mortiflix keys` : `${k.name}: not set (optional)`);
  }
  const extra = keys.sessionKeyNames(root);
  row(true, 'session.env', extra.length ? `other keys for sessions: ${extra.join(', ')}` : 'no other keys (optional: mortiflix keys)');
}

function pipelines(root) {
  for (const p of listPipelines(existsSync(paths(root).config) ? root : null)) {
    if (p.error) { console.log(`${C.red('✖')} ${p.slug}: ${p.error}`); continue; }
    console.log(`${C.b(p.slug.padEnd(14))} ${p.name} ${C.dim(`(${p.source})`)}`);
    console.log(`${' '.repeat(15)}${C.dim(p.description)}`);
    console.log(`${' '.repeat(15)}${p.steps.map((s) => (s.review === 'internal' ? C.dim(s.name) : s.name)).join(' → ')}\n`);
  }
}

async function newProject(root, slug, a) {
  needStudio(root);
  if (!slug) throw new Error('mortiflix new <pipeline> (see: mortiflix pipelines)');
  const pipeline = findPipeline(root, slug);
  const answers = {};
  for (const kv of a.set) { const [k, ...v] = String(kv).split('='); answers[k] = v.join('='); }
  const files = a.file.map((kv) => { const [k, ...v] = String(kv).split('='); return { field: k, path: resolve(v.join('=')) }; });
  const tty = process.stdin.isTTY && !a.yes;
  let title = typeof a.title === 'string' ? a.title : '';
  if (tty) {
    const rl = prompter();
    try {
      console.log(`${C.b(pipeline.name)}  ${C.dim(pipeline.description)}\n`);
      if (!title) title = (await rl.question(`${C.b('Title')}: `)).trim();
      for (const q of pipeline.intake) {
        if (q.type === 'files' ? files.some((f) => f.field === q.id) : answers[q.id] !== undefined) continue;
        const label = `${C.b(q.label || q.id)}${q.required ? '' : C.dim(' (optional)')}`;
        if (q.help) console.log(C.dim(`  ${q.help}`));
        if (q.type === 'files') {
          const v = (await rl.question(`${label} ${C.dim('file paths, comma separated')}: `)).trim();
          for (const f of v.split(',').map((s) => s.trim()).filter(Boolean)) files.push({ field: q.id, path: resolve(f.replace(/^~(?=\/)/, process.env.HOME)) });
        } else if (q.type === 'choice') {
          q.choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}${c === q.default ? C.dim(' (default)') : ''}`));
          const v = (await rl.question(`${label} [${q.default ? q.choices.indexOf(q.default) + 1 : 1}]: `)).trim();
          answers[q.id] = q.choices[Number(v) - 1] || q.default || q.choices[0];
        } else {
          const v = (await rl.question(`${label}: `)).trim();
          if (v) answers[q.id] = v;
        }
      }
    } finally {
      rl.close();
    }
  }
  for (const q of pipeline.intake) if (q.type === 'choice' && answers[q.id] === undefined && q.default) answers[q.id] = q.default;
  // Before anything is made: the keys this project will need, asked for here instead of failing mid-project.
  const missing = keys.missingKeys(root, { backend: typeof a.backend === 'string' ? a.backend : null, pipeline });
  if (missing.length) {
    if (!tty) throw new Error(keys.missingKeysText(missing, 'run this again'));
    console.log(`\n${C.acc('●')} Before it starts: this project needs your ${missing.map((id) => keys.KEYS[id].name).join(' and ')}.`);
    for (const id of missing) if (!(await askKey(root, id, { required: true }))) throw new Error(`no ${keys.KEYS[id].name}: nothing was created`);
  }
  const p = createProject(root, { pipeline: slug, title, answers, backend: typeof a.backend === 'string' ? a.backend : null });
  for (const f of files) {
    if (!existsSync(f.path) || !statSync(f.path).isFile()) throw new Error(`no file ${f.path}`);
    await addIntakeFile(root, p.id, { field: f.field, name: basename(f.path), stream: createReadStream(f.path) });
  }
  startProject(root, p.id);
  console.log(`\n${C.green('✔')} ${C.b(p.title)} is queued as ${C.b(p.id)}`);
  console.log(`  ${C.b('mortiflix run')} starts it (or it starts by itself under ${C.b('mortiflix serve')}).`);
  return p.id;
}

async function runLoop(root, a) {
  needStudio(root);
  const runner = new Runner(root, { log: (line) => console.log(C.dim(line)) });
  runner.acquire();
  let lastProject = null;
  runner.on('activity', (x) => {
    if (x.project !== lastProject) { console.log(`\n${C.b(x.project)}`); lastProject = x.project; }
    const mark = { text: '│', tool: C.dim('›'), error: C.red('!'), info: C.acc('●') }[x.kind] || ' ';
    console.log(`${mark} ${x.kind === 'tool' ? C.dim(x.text) : x.text.split('\n').join('\n  ')}`);
  });
  const stop = async () => { console.log(C.dim('\nStopping the current session…')); await runner.stop(); runner.release(); process.exit(130); };
  process.once('SIGINT', stop);
  try {
    await runner.loop({ watch: Boolean(a.watch) });
  } finally {
    runner.release();
  }
  const waiting = listProjects(root).filter((p) => p.state === 'waiting' || p.state === 'paused');
  if (waiting.length) {
    console.log(`\n${C.acc('●')} Your turn:`);
    for (const p of waiting) console.log(`  ${C.b(p.id)}  ${p.state === 'paused' ? C.red(`needs you: ${p.needs_you?.text}`) : 'ready to review'}  → mortiflix review ${p.id}`);
  } else console.log(C.dim('\nNothing left to run.'));
}

const STATE_LABEL = { draft: 'draft', queued: 'in production', waiting: 'your turn', paused: 'needs you', delivered: 'delivered', cancelled: 'cancelled' };

function list(root) {
  needStudio(root);
  const all = listProjects(root);
  if (!all.length) return console.log(`No projects yet: ${C.b('mortiflix new <pipeline>')} or ${C.b('mortiflix demo')}.`);
  for (const p of all) {
    const label = STATE_LABEL[p.state];
    const tag = p.state === 'waiting' || p.state === 'paused' ? C.acc(label) : C.dim(label);
    console.log(`${C.b(p.id.padEnd(34))} ${p.title.slice(0, 40).padEnd(40)} ${tag}${p.session?.running ? C.dim(' · working now') : ''}`);
  }
}

function status(root, id) {
  const p = loadProject(root, id);
  const pipeline = projectPipeline(root, id);
  console.log(`${C.b(p.title)}  ${C.dim(`${pipeline.name} · ${p.id}`)}`);
  console.log(`${STATE_LABEL[p.state]}${p.status ? ` · ${p.status.text}` : ''}${p.needs_you ? `\n${C.red(`needs you: ${p.needs_you.text}`)}` : ''}\n`);
  for (const s of gates.stepView(p, pipeline)) {
    const icon = { approved: C.green('✔'), done: C.green('✔'), in_review: C.acc('●'), changes: C.red('↺'), working: '…', ready: '○', blocked: C.dim('·') }[s.state];
    console.log(`${icon} ${s.name.padEnd(16)} ${C.dim(s.state.replace('_', ' '))}${s.version ? C.dim(` v${s.version}`) : ''}`);
  }
  const usage = p.usage;
  console.log(C.dim(`\n${usage.sessions} session(s)${usage.cost_usd ? ` · $${usage.cost_usd}` : ''}${usage.output_tokens ? ` · ${usage.output_tokens.toLocaleString()} output tokens` : ''}`));
  console.log(C.dim('\nLog:'));
  for (const e of readEvents(root, id, { limit: 12 })) console.log(C.dim(`  ${e.t.slice(5, 16).replace('T', ' ')} ${e.event}${e.step ? ` ${e.step}${e.version ? ` v${e.version}` : ''}` : ''} ${e.details ? `· ${e.details.slice(0, 80)}` : ''}`));
}

// Review in the terminal: what was sent, then answers, notes and a decision.
async function review(root, given) {
  needStudio(root);
  const ids = given ? [pick(root, given)] : listProjects(root).filter((p) => p.state === 'waiting').map((p) => p.id);
  if (!ids.length) return console.log('Nothing is waiting for you.');
  const rl = prompter();
  try {
    for (const id of ids) {
      const p = loadProject(root, id);
      const pipeline = projectPipeline(root, id);
      console.log(`\n${C.b(p.title)}  ${C.dim(p.id)}`);
      for (const q of p.questions.filter((x) => !x.answered_at)) {
        console.log(`\n${C.acc('?')} ${q.text}${q.choices ? C.dim(` (${q.choices.join(' / ')})`) : ''}`);
        const v = (await rl.question(`  Answer${q.default ? C.dim(` [${q.default}]`) : ''}: `)).trim();
        gates.answerQuestion(root, id, q.id, v || null);
      }
      for (const s of gates.stepView(loadProject(root, id), pipeline).filter((x) => x.state === 'in_review')) {
        const sub = gates.submissions(root, id).filter((x) => x.step === s.key).at(-1);
        console.log(`\n${C.acc('●')} ${C.b(`${s.name} v${sub.version}`)}\n\n${sub.note}\n`);
        if (sub.pin_changes.length) {
          console.log(C.b('What changed for your notes:'));
          for (const c of sub.pin_changes) console.log(`  ${c.note}. ${c.change} ${C.dim(`(${c.status.replace('_', ' ')})`)}`);
          console.log();
        }
        sub.items.forEach((it, i) => {
          if (it.kind === 'text') {
            console.log(`${C.b(`[${i}] ${it.label}`)}`);
            it.text.split(/\n\s*\n/).forEach((para, n) => console.log(`  ${C.dim(`¶${n}`)} ${para.trim().split('\n').join('\n     ')}`));
          } else console.log(`${C.b(`[${i}] ${it.label}`)} ${C.dim(it.kind)}  ${join(projectPaths(root, id).state, it.file)}`);
        });
        const files = sub.items.filter((it) => it.file);
        if (files.length && process.platform === 'linux' && (await rl.question(C.dim('\nOpen the files? [y/N] '))).toLowerCase() === 'y') {
          for (const it of files) spawn('xdg-open', [join(projectPaths(root, id).state, it.file)], { detached: true, stdio: 'ignore' }).unref();
        }
        const answers = {};
        for (const q of sub.questions) {
          console.log(`\n${C.acc('?')} ${q.text}${q.choices ? C.dim(` (${q.choices.join(' / ')})`) : ''}`);
          const v = (await rl.question(`  Answer${q.default !== null ? C.dim(` [${q.default}]`) : ''}: `)).trim();
          answers[q.id] = v || null;
        }
        let choice = '';
        while (!['a', 'c', 's'].includes(choice)) choice = (await rl.question(`\n${C.b('[a]')}pprove, ask for ${C.b('[c]')}hanges, or ${C.b('[s]')}kip? `)).trim().toLowerCase()[0] || '';
        if (choice === 's') continue;
        if (choice === 'a') {
          gates.respond(root, id, s.key, sub.version, { verdict: 'approve', answers });
          console.log(C.green(`✔ ${s.name} approved.`));
          continue;
        }
        console.log(C.dim('Notes, one per line, blank line to finish. Point at things with a prefix:\n  2: text        item 2\n  2@0.5,0.3: …  a spot on item 2 (fractions across, down)\n  1@12.5s: …    12.5 s into item 1\n  0¶3: …        paragraph 3 of item 0'));
        const notes = [];
        for (;;) {
          const line = (await rl.question(`  ${notes.length + 1}. `)).trim();
          if (!line) break;
          notes.push(parseNote(line));
        }
        const overall = (await rl.question('Overall comment (optional): ')).trim();
        gates.respond(root, id, s.key, sub.version, { verdict: 'changes', notes, overall, answers });
        console.log(C.acc(`↺ Changes sent. ${C.b('mortiflix run')} makes the next version.`));
      }
    }
  } finally {
    rl.close();
  }
}

export function parseNote(line) {
  const m = line.match(/^(\d+)(?:@([\d.]+),([\d.]+)|@([\d.]+)s|¶(\d+))?:\s*(.+)$/);
  if (!m) return { text: line };
  const note = { item: Number(m[1]), text: m[6] };
  if (m[2] !== undefined) Object.assign(note, { x: Number(m[2]), y: Number(m[3]) });
  if (m[4] !== undefined) note.time_sec = Number(m[4]);
  if (m[5] !== undefined) note.paragraph = Number(m[5]);
  return note;
}

async function serve(root, a) {
  ensureStudio(root);
  const { startServer } = await import('./web/server.mjs');
  const config = loadConfig(root);
  await startServer(root, { port: Number(a.port || config.port), host: typeof a.host === 'string' ? a.host : config.host });
}

async function config(root, [key, value]) {
  needStudio(root);
  if (key === 'api-key') return keysCmd(root, ['set', 'anthropic']); // older spelling of `mortiflix keys set anthropic`
  const cur = loadConfig(root);
  if (!key) {
    for (const [k, v] of Object.entries(cur)) console.log(`${k.padEnd(18)} ${JSON.stringify(v)}`);
    return undefined;
  }
  if (!(key in cur)) throw new Error(`unknown setting "${key}"`);
  if (value === undefined) return console.log(JSON.stringify(cur[key]));
  let v = value;
  if (['true', 'false'].includes(value)) v = value === 'true';
  else if (value === 'null') v = null;
  else if (/^\d+$/.test(value)) v = Number(value);
  if (key === 'backend' && !BACKENDS[v]) throw new Error('backend must be claude-code, anthropic-api or demo');
  saveConfig(root, { [key]: v });
  console.log(`${C.green('✔')} ${key} = ${JSON.stringify(v)}`);
}

// A prompt that doesn't echo what's typed (for keys).
function hiddenPrompt(question) {
  process.stdout.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((ok) => { let buf = ''; stdin.setEncoding('utf8'); stdin.on('data', (d) => { buf += d; }); stdin.on('end', () => ok(buf.split('\n')[0])); });
  }
  return new Promise((ok) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return ok(buf); }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---- keys ----

const SOURCE_WORDS = { saved: 'saved in this studio', 'session.env': 'from session.env', environment: 'from your environment' };

function showKeys(root) {
  console.log(`${C.b('Your keys')} ${C.dim(`(in ${paths(root).secrets} and session.env, readable by you alone; never shown)`)}`);
  for (const k of keys.keyStatus(root)) {
    const mark = k.source ? C.green('✔') : k.in_use ? C.red('✖') : C.dim('·');
    console.log(`  ${mark} ${k.name.padEnd(20)} ${k.source ? SOURCE_WORDS[k.source] : k.in_use ? C.red('missing: your studio uses it') : C.dim('not set')}${k.source && k.in_use ? C.dim('  ← in use') : ''}`);
  }
  const extra = keys.sessionKeyNames(root);
  console.log(`  ${C.dim('·')} ${'Other keys'.padEnd(20)} ${extra.length ? extra.join(', ') : C.dim('none')} ${C.dim('(handed to every session)')}`);
}

// Ask for one key without echoing it, check it with a free call, and save it. Returns where the key now comes from
// (null if there's none). Enter keeps what's there (or skips), "-" removes a saved key.
async function askKey(root, id, { required = false } = {}) {
  const k = keys.KEYS[id];
  const source = keys.keySource(root, id);
  console.log(`\n${C.b(k.name)}  ${C.dim(`For ${k.for}`)}`);
  console.log(C.dim(`  Get one at ${k.get}`));
  const hint = source ? `Enter keeps the one ${SOURCE_WORDS[source].replace(/^saved /, '')}${source === 'saved' ? ', - removes it' : ''}` : required ? 'Enter to stop' : 'Enter skips';
  for (;;) {
    const v = (await hiddenPrompt(`  Paste it ${C.dim(`(hidden; ${hint})`)}: `)).trim();
    if (!v) return source;
    if (v === '-') { keys.saveKey(root, id, null); console.log('  Removed.'); return keys.keySource(root, id); }
    process.stdout.write(C.dim('  Checking… '));
    const r = await keys.verifyKey(root, id, v);
    if (r.ok === false) { console.log(C.red(`✖ ${r.detail}. Try again.`)); continue; }
    keys.saveKey(root, id, v);
    if (r.tier) voice.saveVoice(root, { elevenlabs: { tier: r.tier } });
    console.log(r.ok ? `${C.green('✔')} ${r.detail}. Saved.` : `${C.acc('●')} Saved, but ${r.detail}.`);
    return 'saved';
  }
}

// The walk-through: every key in turn, then any others sessions should get.
async function keysWalk(root) {
  for (const id of Object.keys(keys.KEYS)) await askKey(root, id);
  console.log(`\n${C.b('Other keys for sessions')}  ${C.dim('Anything a pipeline\'s tools read from the environment, e.g. GEMINI_API_KEY.')}`);
  for (;;) {
    const name = (await prompterOnce(`  Name ${C.dim('(Enter when done)')}: `)).trim().toUpperCase();
    if (!name) break;
    const value = (await hiddenPrompt(`  ${name} ${C.dim('(hidden; Enter removes it)')}: `)).trim();
    try { keys.setSessionKey(root, name, value); console.log(value ? `  ${C.green('✔')} Saved.` : '  Removed.'); } catch (e) { console.log(C.red(`  ✖ ${e.message}`)); }
  }
  console.log();
  showKeys(root);
  const v = voice.voiceConfig(root);
  if (keys.keySource(root, 'elevenlabs') && v.engine !== 'elevenlabs') console.log(`\n  To narrate with it: ${C.b('mortiflix voice elevenlabs')} (pick a voice and model).`);
}

async function keysCmd(root, [sub, name]) {
  needStudio(root);
  if (sub === 'set' || sub === 'remove') {
    if (!name) throw new Error(`mortiflix keys ${sub} <${Object.keys(keys.KEYS).join('|')}|NAME>`);
    const id = keys.KEYS[name.toLowerCase()] ? name.toLowerCase() : null;
    if (sub === 'remove') {
      if (id) keys.saveKey(root, id, null); else keys.setSessionKey(root, name, null);
      return console.log('Removed.');
    }
    if (id && process.stdin.isTTY) return askKey(root, id);
    const value = (await hiddenPrompt(process.stdin.isTTY ? `${name} ${C.dim('(hidden)')}: ` : '')).trim();
    if (!value) throw new Error('no key given');
    if (!id) { keys.setSessionKey(root, name, value); return console.log(`${C.green('✔')} ${name} saved in session.env.`); }
    const r = await keys.verifyKey(root, id, value);
    if (r.ok === false) throw new Error(r.detail);
    keys.saveKey(root, id, value);
    if (r.tier) voice.saveVoice(root, { elevenlabs: { tier: r.tier } });
    return console.log(`${C.green('✔')} ${keys.KEYS[id].name} saved${r.ok ? ` (${r.detail})` : `, but ${r.detail}`}.`);
  }
  if (sub) throw new Error('mortiflix keys [set|remove <name>]');
  if (!process.stdin.isTTY) return showKeys(root);
  return keysWalk(root);
}

// One visible line from the terminal (a fresh readline each time, so it can take turns with hiddenPrompt).
async function prompterOnce(question) {
  const rl = prompter();
  try { return (await rl.question(question)) ?? ''; } catch { return ''; } finally { rl.close(); }
}

function checks(root, [action, id]) {
  needStudio(root);
  if (action === 'approve' || action === 'reject') {
    const c = gates.decideCheck(root, id, action === 'approve');
    return console.log(`${action === 'approve' ? C.green('✔ Added to the checklist') : 'Rejected'}: ${c.title}`);
  }
  const all = readJson(paths(root).checks);
  console.log(C.b('Proposed by sessions (waiting for you):'));
  for (const c of all.proposed) console.log(`  ${C.acc(c.id)}  ${c.title}\n    ${C.dim(c.how)}${c.example ? `\n    ${C.dim(`e.g. ${c.example}`)}` : ''}`);
  if (!all.proposed.length) console.log(C.dim('  none'));
  console.log(C.b('\nYour checklist (on top of each pipeline\'s own):'));
  for (const c of all.active) console.log(`  ${c.id}  ${c.title}`);
  if (!all.active.length) console.log(C.dim('  none yet'));
}

// The narration offer: ElevenLabs always; the local voice when this machine's graphics card can run it.
function voiceOffer() {
  const rec = voice.qwen.recommend(voice.qwen.detectGpus());
  const eleven = `${C.b('mortiflix voice elevenlabs')} for ElevenLabs voices (a key from elevenlabs.io)`;
  return rec.fits ? `${eleven}, or ${C.b('mortiflix voice local')}: ${rec.reason} Free and private, through ComfyUI.` : `${eleven}.`;
}

async function voiceCmd(root, [sub, ...words]) {
  needStudio(root);
  const v = voice.voiceConfig(root);
  if (!sub) {
    const o = voice.voiceOverview(root);
    console.log(`Narration: ${C.b({ none: 'none', elevenlabs: 'ElevenLabs', qwen: 'Qwen3-TTS on this computer' }[o.engine])}`);
    if (o.engine === 'elevenlabs') console.log(`  voice ${o.elevenlabs.voice_name || C.red('not chosen')} · model ${o.elevenlabs.model_id} · key ${o.elevenlabs_key || C.red('missing')}`);
    if (o.engine === 'qwen') console.log(`  ${o.qwen.voice} · ${o.qwen.model} · ${o.qwen.language} · ComfyUI ${o.qwen.url}`);
    console.log(`\nThis machine: ${o.gpus.length ? o.gpus.map((g) => `${g.name} (${g.vram_gb} GB)`).join(', ') : 'no NVIDIA GPU found'}`);
    console.log(`  ${o.local.reason}`);
    console.log(`\nOptions: ${voiceOffer()}`);
    return;
  }
  if (sub === 'none') { voice.saveVoice(root, { engine: 'none' }); return console.log('Narration off: videos use on-screen text, music and sound.'); }
  if (sub === 'test') return voiceTest(root, words.join(' '));
  const rl = prompter();
  try {
    if (sub === 'elevenlabs') {
      if (!voice.elevenKey(root)) {
        rl.close();
        if (!(await askKey(root, 'elevenlabs', { required: true }))) throw new Error('no key given');
        return voiceCmd(root, ['elevenlabs']);
      }
      const el = new voice.eleven.ElevenLabs({ key: voice.elevenKey(root), server: v.elevenlabs.server });
      const a = await el.account();
      voice.saveVoice(root, { engine: 'elevenlabs', elevenlabs: { tier: a.tier } });
      console.log(`${C.green('✔')} ${a.tier} plan · ${a.characters_left.toLocaleString()} credits left${a.commercial_use ? ' · commercial use' : C.red(' · free plan: non-commercial, credit ElevenLabs')}`);
      const search = (await rl.question(`Find a voice (e.g. "warm narrator", blank for all)${v.elevenlabs.voice_name ? C.dim(` [keep ${v.elevenlabs.voice_name}]`) : ''}: `)).trim();
      if (search || !v.elevenlabs.voice_id) {
        let { voices: list } = await el.voices({ search, page_size: 15 });
        let fromLibrary = false;
        if (!list.length) { list = (await el.library({ search, page_size: 15 })).voices; fromLibrary = true; }
        if (!list.length) throw new Error('no voices match');
        list.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. ${C.b(x.name)} ${C.dim(Object.values(x.labels || {}).filter(Boolean).join(' · '))}${fromLibrary ? C.dim(' (Voice Library)') : ''}`));
        const pick = list[Number((await rl.question('Number: ')).trim()) - 1];
        if (!pick) throw new Error('no voice picked');
        const id = fromLibrary ? (await el.addFromLibrary(pick.owner, pick.id, pick.name)).id : pick.id;
        voice.saveVoice(root, { elevenlabs: { voice_id: id, voice_name: pick.name } });
      }
      const models = await el.models();
      console.log(`Model: ${models.map((m, i) => `${i + 1}. ${m.id}${m.recommended ? C.dim(' (recommended)') : ''}`).join('  ')}`);
      const m = models[Number((await rl.question(`Number ${C.dim(`[${v.elevenlabs.model_id}]`)}: `)).trim()) - 1];
      if (m) voice.saveVoice(root, { elevenlabs: { model_id: m.id } });
      const now = voice.voiceConfig(root).elevenlabs;
      console.log(`${C.green('✔')} ElevenLabs: ${now.voice_name} on ${now.model_id}. Every other option (stability, format, dictionaries, sound effects, music) is in the web studio's Settings.`);
      console.log(`  Hear it: ${C.b('mortiflix voice test')}`);
      return;
    }
    if (sub === 'local') {
      const rec = voice.qwen.recommend(voice.qwen.detectGpus());
      console.log(rec.fits ? `${C.green('✔')} ${rec.reason}` : C.red(rec.reason));
      const url = (await rl.question(`ComfyUI address ${C.dim(`[${v.qwen.url}]`)}: `)).trim() || v.qwen.url;
      const st = await new voice.qwen.ComfyUI({ url }).status();
      if (!st.ok) {
        console.log(C.red(st.reason));
        console.log('  1. Install ComfyUI: https://www.comfy.org/download (it listens on http://127.0.0.1:8188)');
        console.log('  2. In ComfyUI Manager install "TTS Audio Suite" (github.com/diodiogod/TTS-Audio-Suite), restart ComfyUI');
        console.log(`  3. Run ${C.b('mortiflix voice local')} again. The Qwen3-TTS models (Apache-2.0) download on first use, about 4 GB.`);
        voice.saveVoice(root, { qwen: { url } });
        return;
      }
      console.log(`${C.green('✔')} ComfyUI ${st.comfyui || ''} with the TTS Audio Suite · ${st.gpu} · ${st.vram_free_gb} GB free`);
      st.voices.forEach((name, i) => { const p = voice.qwen.PRESETS.find((x) => x.id === name); console.log(`  ${i + 1}. ${C.b(name)} ${C.dim(p ? `${p.language}: ${p.about}` : '')}`); });
      const name = st.voices[Number((await rl.question(`Voice ${C.dim(`[${v.qwen.voice}]`)}: `)).trim()) - 1] || v.qwen.voice;
      voice.saveVoice(root, { engine: 'qwen', qwen: { url, voice: name, model: rec.model || v.qwen.model } });
      console.log(`${C.green('✔')} Local narration: ${name} on Qwen3-TTS ${rec.model || v.qwen.model}. Hear it: ${C.b('mortiflix voice test')}`);
      return;
    }
    throw new Error('mortiflix voice [elevenlabs|local|none|test]');
  } finally {
    rl.close();
  }
}

async function voiceTest(root, text) {
  const v = voice.voiceConfig(root);
  const line = text || 'Every city has a heartbeat. Ours runs on bikes.';
  let out;
  if (v.engine === 'elevenlabs') out = { ...(await new voice.eleven.ElevenLabs({ key: voice.elevenKey(root), server: v.elevenlabs.server }).sample(v.elevenlabs, line)), format: 'mp3' };
  else if (v.engine === 'qwen') out = await new voice.qwen.ComfyUI({ url: v.qwen.url }).sample(v.qwen, line);
  else throw new Error('no narration engine set up (mortiflix voice elevenlabs | local)');
  const file = join(paths(root).run, `voice-test.${out.format}`);
  writeFileSync(file, out.audio);
  console.log(`${C.green('✔')} ${file}`);
  if (spawnSync('ffplay', ['-version']).status === 0) spawnSync('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', file], { stdio: 'inherit' });
}

// The walk-through: a logo sting made by the demo backend, so the whole loop can be tried for free.
async function demo(root) {
  if (!existsSync(paths(root).config)) await init(root, { yes: true });
  const logo = join(paths(root).run, 'demo-logo.svg');
  writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="80" fill="#f97316"/><text x="100" y="118" text-anchor="middle" font-size="56" font-family="sans-serif" fill="#fff">M</text></svg>');
  const id = await newProject(root, 'logo-sting', { _: [], set: ['mood=calm and premium'], file: [`logo=${logo}`], title: 'Demo sting', backend: 'demo', yes: true });
  console.log(`\nThis project uses the ${C.b('demo')} backend (placeholder work, no Claude). Running it now…`);
  await runLoop(root, {});
  console.log(`\nNext: ${C.b(`mortiflix review ${id}`)} in the terminal, or ${C.b('mortiflix serve')} to review in the browser.`);
}

