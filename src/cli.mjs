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
import * as setup from './setup.mjs';
import { costText } from './usage.mjs';
import * as booth from './booth.mjs';
import * as rec from './record.mjs';
import * as pub from './publish.mjs';

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, acc: (s) => `\x1b[38;5;208m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m` }
  : { b: (s) => s, dim: (s) => s, acc: (s) => s, red: (s) => s, green: (s) => s };

const HELP = `${C.b('mortiflix')}: a motion design studio on your machine. Claude makes the video, you approve every stage.

  ${C.b('Getting started')}
  mortiflix init [--backend claude-code|anthropic-api|demo]   set up the studio (~/Mortiflix, or $MORTIFLIX_STUDIO)
  mortiflix setup                                              the walkthrough: Claude, transitions, narration, music, assets, 3D
  mortiflix setup <claude|transitions|narration|music|assets|3d>  one part (mortiflix setup status: where things stand)
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
  mortiflix reopen <project> <step> "what to change"           send an approved step back (you changed your mind)
  mortiflix pause|resume|cancel <project>

  ${C.b('Publishing')}
  mortiflix publish <project> [--to tiktok,instagram,youtube] [--profile <name>] [--title "…"] [--description "…"]
                    [--at 2026-10-20T18:00 [--timezone Europe/Madrid]] [--yes]
                                                               post a delivered video through Upload-Post (asks first)
  mortiflix publish <project> --status                         how it went, per platform, with the links

  ${C.b('The web studio')}
  mortiflix serve [--port 4646] [--host 127.0.0.1]             the studio in your browser, with the runner

  ${C.b('Narration')}
  mortiflix voice                                              what narrates your videos, and what this machine can run
  mortiflix voice elevenlabs                                   set up ElevenLabs (key, voice, model)
  mortiflix voice local                                        set up Qwen3-TTS on your GPU through ComfyUI
  mortiflix voice own                                          narrate in your own voice, recorded in the booth
  mortiflix voice none                                         no narration (on-screen text and music)
  mortiflix voice test ["a line to speak"]                     hear the current voice
  mortiflix record [<project>] [--device <mic>]                the recording booth in this terminal: read each line, keep the best take
  mortiflix record <project> --import <folder>                 use files you recorded elsewhere, named after the lines (b01-1.wav…)
  mortiflix record --list-devices                              the microphones ffmpeg can record from

  ${C.b('3D')}
  mortiflix blender [file.blend]                               open the studio's Blender, with its toolkits and Camera Flight

  ${C.b('Settings')}
  mortiflix config [key [value]]                               show or change settings
  mortiflix keys set <anthropic|elevenlabs|uploadpost|NAME>    set one key (typed hidden, or piped on stdin)
  mortiflix keys remove <anthropic|elevenlabs|uploadpost|NAME>
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
    // `--help` anywhere prints help: it never runs the command (`serve --help` used to start a server).
    if (a.help || a.h) return console.log(HELP);
    switch (cmd) {
      case 'init': return init(root, a);
      case 'keys': return keysCmd(root, rest);
      case 'setup': return setupCmd(root, rest, a);
      case 'blender': needStudio(root); return console.log(`Opening ${setup.openBlender(root, rest)} with the studio's profile (Camera Flight: 3D Viewport › N › Flight).`);
      case 'doctor': return doctor(root);
      case 'demo': return demo(root);
      case 'pipelines': return pipelines(root);
      case 'new': return newProject(root, rest[0], a);
      case 'run': return runLoop(root, a);
      case 'list': case 'ls': return list(root);
      case 'status': return status(root, pick(root, rest[0]));
      case 'review': return review(root, rest[0]);
      case 'pause': gates.pause(root, pick(root, rest[0])); return console.log('Paused.');
      case 'reopen': {
        const [proj, step, ...words] = rest;
        if (!step || !words.length) throw new Error('mortiflix reopen <project> <step> "what to change"');
        gates.reopen(root, pick(root, proj), step, { overall: words.join(' ') });
        return console.log(`${C.acc('↺')} ${step} goes back for changes. ${C.b('mortiflix run')} makes the next version.`);
      }
      case 'resume': gates.resume(root, pick(root, rest[0])); return console.log('Resumed: it will run on the next `mortiflix run` (or right away under `serve`).');
      case 'cancel': gates.cancel(root, pick(root, rest[0])); return console.log('Cancelled.');
      case 'publish': return publishCmd(root, rest[0], a);
      case 'serve': return serve(root, a);
      case 'config': return config(root, rest);
      case 'checks': return checks(root, rest);
      case 'voice': return voiceCmd(root, rest);
      case 'record': return recordCmd(root, rest, a);
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
    console.log(`\n  Next, the setup walkthrough: what Mortiflix uses (Claude, transitions, narration, music, assets, 3D), why, and what it would`);
    console.log('  install. Nothing installs without asking, and you can skip any part.');
    if (await confirm('  Set it up now?', true)) await setupWalk(root);
    else console.log(`  Any time: ${C.b('mortiflix setup')}`);
  } else console.log(`\n  Next: ${C.b('mortiflix setup')} walks through Claude, transitions, narration, music, assets and 3D.`);
  console.log(`\n  Then: ${C.b('mortiflix demo')} for a free walk-through, or ${C.b('mortiflix serve')} to open the studio in your browser.`);
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
  const tools = setup.setupStatusSync(root);
  for (const id of ['strudel', 'chrome', 'browser-harness', 'blender', 'blender-addons']) row(tools[id].ok || !['strudel', 'chrome'].includes(id) || tools.music.engine === 'none', id, tools[id].ok ? tools[id].detail : `${tools[id].detail} (mortiflix setup)`);
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
    const icon = { approved: C.green('✔'), done: C.green('✔'), skipped: C.dim('–'), in_review: C.acc('●'), changes: C.red('↺'), working: '…', ready: '○', blocked: C.dim('·') }[s.state];
    console.log(`${icon} ${s.name.padEnd(16)} ${C.dim(s.state.replace('_', ' '))}${s.version ? C.dim(` v${s.version}`) : ''}`);
  }
  const usage = p.usage;
  console.log(C.dim(`\n${usage.sessions} session(s)${usage.output_tokens ? ` · ${usage.output_tokens.toLocaleString()} output tokens` : ''}`));
  if (costText(usage)) console.log(C.dim(costText(usage)));
  console.log(C.dim('\nLog:'));
  for (const e of readEvents(root, id, { limit: 12 })) console.log(C.dim(`  ${e.t.slice(5, 16).replace('T', ' ')} ${e.event}${e.step ? ` ${e.step}${e.version ? ` v${e.version}` : ''}` : ''} ${e.details ? `· ${e.details.slice(0, 80)}` : ''}`));
}

// Publishing: shows exactly what goes where, asks, then sends. Never runs on its own.
async function publishCmd(root, given, a) {
  const id = pick(root, given);
  const opt = (k) => (typeof a[k] === 'string' ? a[k] : undefined);
  if (a.status) {
    const st = await pub.publishStatus(root, id);
    console.log(`${C.b(st.status)}${st.message ? C.dim(` · ${st.message}`) : ''}  ${C.dim(st.job_id ? `job ${st.job_id}` : `request ${st.request_id}`)}`);
    for (const r of st.results) {
      const icon = { completed: C.green('✔'), failed: C.red('✖') }[r.state] || C.acc('●');
      console.log(`  ${icon} ${r.platform.padEnd(10)} ${r.url || C.dim(r.message || r.state)}`);
    }
    if (!st.results.length) console.log(C.dim(st.scheduled_for ? `  Scheduled for ${st.scheduled_for}.` : '  Nothing back from the platforms yet.'));
    return;
  }
  const plan = pub.publishPlan(root, id, { to: opt('to'), profile: opt('profile'), title: opt('title'), description: opt('description'), at: opt('at'), timezone: opt('timezone') });
  console.log(`\n${C.b(plan.project)}  ${C.dim(`${(plan.size / 1024 ** 2).toFixed(1)} MB`)}`);
  console.log(`  To      ${plan.platforms.join(', ')}${plan.from_brief ? C.dim(' (from the brief; --to changes it)') : ''}`);
  console.log(`  Profile ${plan.profile}`);
  console.log(`  Title   ${plan.title}`);
  if (plan.description) console.log(`  Text    ${plan.description.slice(0, 200)}`);
  console.log(`  When    ${plan.at ? `${plan.at} ${plan.timezone || 'UTC'}` : 'now'}\n`);
  if (!a.yes && !process.stdin.isTTY) throw new Error('nothing sent: add --yes to post without being asked');
  if (!a.yes && !(await confirm(`Post it${plan.at ? ' at that time' : ' now'}?`))) return console.log('Nothing sent.');
  const sent = await pub.publish(root, plan);
  console.log(`${C.green('✔')} ${plan.at ? 'Scheduled' : 'Sent'}. ${C.b(`mortiflix publish ${id} --status`)} shows how it went.`);
  console.log(C.dim(`  ${sent.job_id ? `job ${sent.job_id}` : `request ${sent.request_id}`} · also at https://app.upload-post.com`));
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

// ---- setup ----

async function confirm(question, yes = false) {
  const v = (await prompterOnce(`${question} ${C.dim(yes ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
  return v ? v.startsWith('y') : yes;
}

const PART_IDS = setup.PARTS.map((p) => p.id);

function partHeader(part, i) {
  console.log(`\n${C.acc(`${i + 1}/${setup.PARTS.length}`)} ${C.b(part.title)}`);
  console.log(`  ${part.why}`);
  console.log(C.dim(`  Needs: ${part.needs}`));
}

// Installs one tool after saying what it is, where it goes and how big it is.
async function offerInstall(root, id, { ask = true } = {}) {
  const info = setup.TOOL_INFO[id];
  console.log(`  ${C.b(info.name)}: ${info.what}. Goes to ${info.where} (${info.size}).`);
  if (ask && !(await confirm('  Install it now?', true))) { console.log(C.dim('  Skipped.')); return false; }
  const started = Date.now();
  try {
    const r = await setup.installTool(root, id, { log: (l) => console.log(C.dim(`    ${l}`)) });
    console.log(`  ${r.problems ? C.acc('●') : C.green('✔')} ${info.name}: ${r.detail || 'installed'}${r.problems ? ` (${r.problems})` : ''} ${C.dim(`${Math.round((Date.now() - started) / 1000)} s`)}`);
    return true;
  } catch (e) {
    console.log(C.red(`  ✖ ${info.name}: ${e.message}`));
    return false;
  }
}

const mark = (ok) => (ok ? C.green('✔') : C.dim('·'));

async function setupPart(root, id, st) {
  if (id === 'claude') {
    const config = loadConfig(root);
    const cc = BACKENDS['claude-code'].available(config, root);
    console.log(`  ${mark(cc.ok)} Claude Code: ${cc.detail}`);
    console.log(`  ${mark(Boolean(keys.keySource(root, 'anthropic')))} Anthropic API key: ${keys.keySource(root, 'anthropic') || 'not set'}`);
    console.log(`  In use: ${C.b(config.backend)}`);
    if (cc.ok && config.backend !== 'claude-code' && await confirm('  Use your Claude Code login (your plan pays)?', true)) saveConfig(root, { backend: 'claude-code' });
    if (!cc.ok) {
      console.log(C.dim('  Claude Code isn\'t installed: https://claude.com/claude-code (then run this again), or use an API key.'));
      if (await confirm('  Use an Anthropic API key instead (you pay per token)?', true) && await askKey(root, 'anthropic', { required: true })) saveConfig(root, { backend: 'anthropic-api' });
    }
    return;
  }
  if (id === 'transitions') {
    if (st.transitions.ok) {
      console.log(`  ${mark(true)} ${st.transitions.detail} (${st.transitions.path})`);
      if (await confirm('  Update the library to its latest version?', false)) await offerInstall(root, 'transitions', { ask: false });
    } else await offerInstall(root, 'transitions', { ask: false });
    return;
  }
  if (id === 'narration') {
    const v = voice.voiceConfig(root);
    const local = st.gpu;
    console.log(`  Now: ${C.b({ none: 'no narration', elevenlabs: 'ElevenLabs', qwen: 'Qwen3-TTS on this computer', own: 'your own voice' }[v.engine])}`);
    console.log(`  1. ElevenLabs: their voices, paid per character. Needs an API key.`);
    console.log(`  2. This computer: Qwen3-TTS through ComfyUI, free and private. ${local.fits ? C.green(local.reason) : C.red(local.reason)}`);
    console.log('  3. No narration: on-screen text, music and sound.');
    console.log('  4. Your own voice: you read the script line by line in the recording booth (web studio or terminal), or import files.');
    const pick = (await prompterOnce(`  Which? ${C.dim(`[Enter keeps ${v.engine}]`)} `)).trim();
    if (pick === '1') { await voiceCmd(root, ['elevenlabs']); }
    else if (pick === '2') {
      if (!local.fits) return console.log(C.red('  This machine can\'t run it: pick ElevenLabs or none.'));
      if (!st.comfyui.ok) {
        if (st.comfyui.installed) { console.log('  The studio\'s ComfyUI is installed but not running: starting it.'); setup.startComfy(root); }
        else if (!(await offerInstall(root, 'comfyui'))) return;
      }
      await voiceCmd(root, ['local']);
    } else if (pick === '3') { voice.saveVoice(root, { engine: 'none' }); console.log('  Narration off.'); }
    else if (pick === '4') await voiceCmd(root, ['own']);
    return;
  }
  if (id === 'music') {
    const m = setup.musicConfig(loadConfig(root));
    if (!(await confirm('  Score your videos with original music (Strudel)?', m.engine !== 'none'))) { setup.saveMusic(root, { engine: 'none' }); return console.log('  No music: music steps are skipped.'); }
    if (!st.strudel.ok) await offerInstall(root, 'strudel', { ask: false });
    else console.log(`  ${mark(true)} Strudel ${st.strudel.version}`);
    if (!st.chrome.ok) await offerInstall(root, 'chrome');
    else { console.log(`  ${mark(true)} Renders in ${st.chrome.path}`); await setup.installTool(root, 'chrome'); }
    console.log(C.dim('  The score is always rendered by Strudel and used in the video. A MIDI pack adds every part as MIDI, the stems'));
    console.log(C.dim('  and a cue sheet (tempo, sections, hit points), for remaking the music in your own DAW.'));
    const midi = await confirm('  Also deliver a MIDI pack with each video?', m.midi);
    setup.saveMusic(root, { engine: 'strudel', midi });
    return console.log(`  ${C.green('✔')} Music: Strudel${midi ? ' + MIDI pack' : ''}.`);
  }
  if (id === 'assets') {
    const cur = setup.assetsConfig(loadConfig(root)).sites;
    if (cur.length) console.log(`  Your sites now: ${cur.map((x) => x.url).join(', ')}`);
    console.log('  If you have a website you use for assets, list it here, one per line (Enter when done).');
    console.log(C.dim('  Without one, you won\'t get stock assets: sessions make every visual themselves.'));
    const sites = [];
    for (;;) {
      const v = (await prompterOnce(`  Site ${sites.length + 1}${cur.length && !sites.length ? C.dim(' (Enter keeps your list, - clears it)') : ''}: `)).trim();
      if (!v) break;
      if (v === '-') { sites.length = 0; setup.saveAssetSites(root, []); console.log('  Cleared.'); break; }
      sites.push(v);
    }
    if (sites.length) {
      try { setup.saveAssetSites(root, sites); } catch (e) { return console.log(C.red(`  ✖ ${e.message}`)); }
    }
    const now = setup.assetsConfig(loadConfig(root)).sites;
    if (!now.length) return console.log('  No asset sites.');
    if (!st['browser-harness'].ok) { if (!(await offerInstall(root, 'browser-harness'))) return; }
    else console.log(`  ${mark(true)} browser-harness ${st['browser-harness'].detail}`);
    const rec = setup.browserHarnessRecordings();
    if (rec && /default/.test(rec)) {
      console.log(C.dim('  browser-harness can save screenshots and action traces of what sessions do in the browser, on this machine'));
      console.log(C.dim('  only (they may include what\'s on those pages), so you can see what happened later.'));
      setup.browserHarnessRecordings(await confirm('  Keep local browser recordings?', false));
    }
    console.log(`  ${C.green('✔')} Sessions will use ${now.map((x) => x.url).join(', ')} in your own Chrome.`);
    console.log(C.dim('  Sign in to them in Chrome. The first time, Chrome may ask to allow remote debugging: chrome://inspect/#remote-debugging'));
    return;
  }
  if (id === '3d') {
    if (!(await confirm('  Set up 3D (Blender and the toolkits)?', st.blender.ok))) return console.log(C.dim('  Skipped: 2D only.'));
    if (!st.blender.ok) { if (!(await offerInstall(root, 'blender'))) return; }
    else { console.log(`  ${mark(true)} ${st.blender.detail} (${st.blender.path})`); await setup.installTool(root, 'blender'); }
    console.log(C.dim('  The toolkits go into the studio\'s own Blender profile: your personal Blender setup is never changed.'));
    for (const t of setup.ADDONS) console.log(C.dim(`    ${t.name}: ${t.about}`));
    console.log(C.dim('  Nova FX, Mortiflix\'s own particle engine, builds on Linux only for now (it compiles its core with gcc).'));
    if (st['blender-addons'].ok && !(await confirm('  They\'re installed. Update them?', false))) return;
    await offerInstall(root, 'blender-addons', { ask: !st['blender-addons'].ok });
    console.log(`  Open it yourself with ${C.b('mortiflix blender')} (Camera Flight is in the 3D Viewport › N › Flight).`);
  }
}

async function showSetup(root) {
  const st = await setup.setupStatus(root);
  const v = voice.voiceConfig(root);
  const config = loadConfig(root);
  const row = (ok, name, detail) => console.log(`  ${ok === null ? C.dim('·') : ok ? C.green('✔') : C.red('✖')} ${name.padEnd(12)} ${detail}`);
  console.log(C.b('Your studio'));
  row(BACKENDS[config.backend].available(config, root).ok, 'Claude', `${config.backend}: ${BACKENDS[config.backend].available(config, root).detail}`);
  row(v.engine === 'none' ? null : v.engine === 'elevenlabs' ? Boolean(voice.elevenKey(root)) && Boolean(v.elevenlabs.voice_id) : st.comfyui.ok, 'Narration',
    v.engine === 'none' ? 'none' : v.engine === 'elevenlabs' ? `ElevenLabs: ${v.elevenlabs.voice_name || 'no voice chosen'} on ${v.elevenlabs.model_id}${voice.elevenKey(root) ? '' : ', key missing'}` : `this computer: ${st.comfyui.detail}`);
  row(st.transitions.ok, 'Transitions', st.transitions.ok ? `remotion-transitions: ${st.transitions.detail}` : 'library not installed (mortiflix setup transitions)');
  row(st.music.engine === 'none' ? null : st.strudel.ok && st.chrome.ok, 'Music', st.music.engine === 'none' ? 'none' : `Strudel: ${st.strudel.detail}; Chrome: ${st.chrome.ok ? 'found' : 'missing'}${st.music.midi ? '; MIDI pack on' : ''}`);
  row(st.assets.sites.length ? st['browser-harness'].ok : null, 'Assets', st.assets.sites.length ? `${st.assets.sites.map((x) => x.url).join(', ')} (browser-harness ${st['browser-harness'].ok ? st['browser-harness'].detail : 'missing'})` : 'no sites: sessions make every visual themselves');
  row(st.blender.ok ? st['blender-addons'].ok : null, '3D', st.blender.ok ? `${st.blender.detail}; ${st['blender-addons'].detail}` : 'not set up');
}

async function setupWalk(root, only = null) {
  ensureStudio(root);
  const parts = only ? setup.PARTS.filter((p) => p.id === only) : setup.PARTS;
  for (const part of parts) {
    partHeader(part, setup.PARTS.indexOf(part));
    if (!only && !(await confirm(`  Set up ${part.title.toLowerCase()} now?`, true))) { console.log(C.dim('  Skipped.')); continue; }
    // One part failing (a service down, a refused key) never ends the whole walkthrough.
    try { await setupPart(root, part.id, await setup.setupStatus(root)); }
    catch (e) { console.log(C.red(`  ✖ ${part.title}: ${e.message}`)); console.log(C.dim(`  Try this part again with: mortiflix setup ${part.id}`)); }
  }
  console.log();
  await showSetup(root);
}

async function setupCmd(root, [part], a) {
  needStudio(root);
  if (part === 'status' || !process.stdin.isTTY) return showSetup(root);
  if (part && !PART_IDS.includes(part)) throw new Error(`mortiflix setup [${PART_IDS.join('|')}|status]`);
  return setupWalk(root, part || null);
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

// The recording booth (src/booth.mjs) from a terminal, or importing takes recorded elsewhere.
async function recordCmd(root, rest, a) {
  if (a['list-devices']) {
    const args = rec.listDevicesArgs();
    if (!args) return console.log('Linux: `pactl list short sources` (PipeWire/PulseAudio) or `arecord -l` (ALSA). Pass one with --device pulse:<name> or --device alsa:hw:1.');
    spawnSync('ffmpeg', args, { stdio: 'inherit' });
    return;
  }
  const id = pick(root, rest[0]);
  if (typeof a.import === 'string') {
    const r = booth.importFolder(root, id, a.import);
    for (const t of r.imported) console.log(`  ${C.green('✔')} ${t.line}  ${t.file}  ${(t.duration_ms / 1000).toFixed(1)} s${t.flags.length ? C.red(`  · ${booth.FLAG_ADVICE[t.flags[0]]}`) : ''}`);
    if (r.missing.length) console.log(`  ${C.red(`${r.missing.length} line(s) had no file`)}: ${r.missing.join(', ')}`);
    return recordDone(root, id);
  }
  await rec.terminalBooth(root, id, { device: typeof a.device === 'string' ? a.device : null });
  return recordDone(root, id);
}

async function recordDone(root, id) {
  const st = booth.boothStatus(root, id);
  if (st.missing.length) return console.log(`\n${st.kept} of ${st.lines.length} lines kept. Carry on any time: ${C.b(`mortiflix record ${id}`)}`);
  console.log(`\n${C.green('✔')} Every line has a kept take.`);
  const p = loadProject(root, id);
  if (p.state === 'paused' && process.stdin.isTTY && !/^n/i.test((await prompterOnce('Give it to the studio now? [Y/n] ')).trim())) {
    gates.resume(root, id);
    console.log('Resumed: the studio builds the narration from your takes.');
  }
}

async function voiceCmd(root, [sub, ...words]) {
  needStudio(root);
  const v = voice.voiceConfig(root);
  if (!sub) {
    const o = voice.voiceOverview(root);
    console.log(`Narration: ${C.b({ none: 'none', elevenlabs: 'ElevenLabs', qwen: 'Qwen3-TTS on this computer', own: 'your own voice (the recording booth)' }[o.engine])}`);
    if (o.engine === 'elevenlabs') console.log(`  voice ${o.elevenlabs.voice_name || C.red('not chosen')} · model ${o.elevenlabs.model_id} · key ${o.elevenlabs_key || C.red('missing')}`);
    if (o.engine === 'qwen') console.log(`  ${o.qwen.voice} · ${o.qwen.model} · ${o.qwen.language} · ComfyUI ${o.qwen.url}`);
    console.log(`\nThis machine: ${o.gpus.length ? o.gpus.map((g) => `${g.name} (${g.vram_gb} GB)`).join(', ') : 'no NVIDIA GPU found'}`);
    console.log(`  ${o.local.reason}`);
    console.log(`\nOptions: ${voiceOffer()}`);
    return;
  }
  if (sub === 'none') { voice.saveVoice(root, { engine: 'none' }); return console.log('Narration off: videos use on-screen text, music and sound.'); }
  if (sub === 'own') {
    voice.saveVoice(root, { engine: 'own' });
    console.log(`${C.green('✔')} Narration: your own voice. When a video reaches its narration, the studio writes the script as short lines and asks you to record them:`);
    console.log(`  in the web studio (the project's ${C.b('Record narration')} button), in a terminal (${C.b('mortiflix record <project>')}),`);
    console.log(`  or from files you recorded elsewhere (${C.b('mortiflix record <project> --import <folder>')}).`);
    return;
  }
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

