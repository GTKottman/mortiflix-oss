// mfx: the command a session uses to talk to the studio. It only works inside a session (the runner sets
// MFX_SOCKET and MFX_TOKEN). See harness/GATES.md for the protocol.
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE = `mfx: talk to the Mortiflix studio from inside a session

  mfx status <key> [--rendering]        what the owner sees while you work     (mfx status --list)
  mfx step start <step>                 mark a step as being worked on
  mfx step done <step> --checks <file>  finish an internal step (file = its error_checks list)
  mfx checks <step>                     the error checks a step runs
  mfx submit <step> <submission.json>   send a step for review, then hand off and stop
  mfx ask <step> "question" [--default "..."] [--choices "A|B"]
  mfx feedback [step]                   everything the owner said
  mfx render --label "..." -- <cmd...>  queue a heavy render (returns an id at once)
  mfx render-wait <id> [seconds]        wait for it (default 100 s)
  mfx handoff "what I did, what's next" required before you stop
  mfx taste "a lasting preference"      remembered for every future project
  mfx log EVENT "details"               add a line to the project log
  mfx needs-you "what you need"         pause the project until the owner helps
  mfx propose-check --work stills,motion --title "..." --how "..." [--example "..."]
  mfx propose-check --same-as <check-id>
  mfx files                             files handed over with the brief

Full protocol: .mortiflix/GATES.md`;

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out['--'] = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function callStudio(command, args, env = process.env) {
  const socketPath = env.MFX_SOCKET;
  const token = env.MFX_TOKEN;
  if (!socketPath || !token) return Promise.reject(new Error('mfx only works inside a Mortiflix session (MFX_SOCKET is not set).'));
  const body = JSON.stringify(args);
  return new Promise((ok, fail) => {
    const req = request({ socketPath, path: `/${command}`, method: 'POST', headers: { 'x-mfx-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return fail(new Error(data || `HTTP ${res.statusCode}`)); }
        if (!parsed.ok) return fail(new Error(parsed.error || `HTTP ${res.statusCode}`));
        ok(parsed.result);
      });
    });
    req.on('error', (e) => fail(new Error(`the studio isn't answering (${e.code || e.message}); the session may have been stopped`)));
    req.end(body);
  });
}

const readJsonFile = (file, cwd) => {
  try { return JSON.parse(readFileSync(resolve(cwd, file), 'utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`); }
};

export async function main(argv, env = process.env, cwd = process.cwd()) {
  const call = (command, args) => callStudio(command, args, env);
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  const need = (v, what) => { if (v === undefined || v === true || v === '') throw new Error(`missing ${what}\n\n${USAGE}`); return v; };
  switch (cmd) {
    case 'status':
      if (f.list) return call('status', { list: true });
      return call('status', { key: need(f._[0], '<key>'), mode: f.rendering ? 'rendering' : 'working' });
    case 'step': {
      const [sub, step] = f._;
      if (sub === 'start') return call('step-start', { step: need(step, '<step>') });
      if (sub === 'done') return call('step-done', { step: need(step, '<step>'), checks: f.checks ? readJsonFile(f.checks, cwd) : [] });
      throw new Error(`mfx step start|done <step>\n\n${USAGE}`);
    }
    case 'checks': return call('checks', { step: need(f._[0], '<step>') });
    case 'submit': return call('submit', { step: need(f._[0], '<step>'), submission: readJsonFile(need(f._[1], '<submission.json>'), cwd) });
    case 'ask': return call('ask', {
      step: need(f._[0], '<step>'),
      text: need(f._[1], '"question"'),
      default: typeof f.default === 'string' ? f.default : null,
      choices: typeof f.choices === 'string' ? f.choices.split('|').map((s) => s.trim()).filter(Boolean) : null,
    });
    case 'feedback': return call('feedback', { step: f._[0] || null });
    case 'render': return call('render', { label: typeof f.label === 'string' ? f.label : null, argv: need(f['--']?.length ? f['--'] : undefined, '-- <command>'), cwd });
    case 'render-wait': return call('render-wait', { id: Number(need(f._[0], '<id>')), seconds: Number(f._[1] || 100) });
    case 'handoff': return call('handoff', { text: need(f._.join(' '), '"text"') });
    case 'taste': return call('taste', { text: need(f._.join(' '), '"text"') });
    case 'log': return call('log', { name: need(f._[0], 'EVENT'), details: f._.slice(1).join(' ') });
    case 'needs-you': return call('needs-you', { text: need(f._.join(' '), '"what you need"') });
    case 'propose-check': return call('propose-check', { title: f.title, how: f.how, example: f.example, work: f.work, same_as: f['same-as'] });
    case 'files': return call('files', {});
    case undefined: case 'help': case '--help': case '-h':
      console.log(USAGE);
      return undefined;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

export async function run() {
  try {
    const out = await main(process.argv.slice(2));
    if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(`mfx: ${e.message}`);
    process.exit(1);
  }
}
