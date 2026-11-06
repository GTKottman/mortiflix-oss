// mfx: the command a session uses to talk to the studio. It only works inside a session (the runner sets
// MFX_SOCKET and MFX_TOKEN). See harness/GATES.md for the protocol.
import { request } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { sheetFor } from './sheet.mjs';

const USAGE = `mfx: talk to the Mortiflix studio from inside a session

  mfx status <key> [--rendering]        what the owner sees while you work     (mfx status --list)
  mfx canvas                            rebuild the canvas from your files (beats, frames, scenes)
  mfx edits                             the owner's open edit requests (do these first)
  mfx edit done|fail <E001> ["note"]    report an edit request: done once its piece has a new version
  mfx step start <step>                 mark a step as being worked on
  mfx step done <step> --checks <file>  finish an internal step (file = its error_checks list)
  mfx checks <step>                     the error checks a step runs
  mfx submit <step> <submission.json>   send a step for review, then hand off and stop
  mfx ask <step> "question" [--default "..."] [--choices "A|B"]
  mfx feedback [step]                   everything the owner said
  mfx render --label "..." -- <cmd...>  queue a heavy render (returns an id at once)
  mfx render-wait <id> [seconds]        wait for it (default 100 s)
  mfx render-stop <id>                  stop it (its whole process group; never pkill/killall by name)
  mfx handoff "what I did, what's next" required before you stop
  mfx taste "a lasting preference"      remembered for every future project
  mfx log EVENT "details"               add a line to the project log
  mfx needs-you "what you need"         pause the project until the owner helps
  mfx propose-check --work stills,motion --title "..." --how "..." [--example "..."]
  mfx propose-check --same-as <check-id>
  mfx files                             files handed over with the brief
  mfx sheet <image...> [--cols 2] [--out sheet.jpg]   one small contact sheet (1280 px) to Read instead of full-size images
  mfx song                              the song in short: sections, parts, locks, open bar edits
  mfx song show m02 [--part ch02] [--bars 3-4]    the notes as a table (bars and beats inside the section)
  mfx song strudel [m02] [--part ch02]  the rows of song.strudel.js, exactly
  mfx song strudel m02 ch02 --bars 3-4 --file bars.strudel.js [--edit E012]   put Strudel in those bars
  mfx song notes m02 ch02 --bars 3-4 --file notes.json [--edit E012]        replace that part's notes there
  mfx song ops <ops.json> [--edit E012] a batch of song operations, all or nothing
  mfx song import                       the song from the checked score (music/notes.json)
  mfx song version "why"                a named version of the song

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
    case 'render-stop': return call('render-stop', { id: Number(need(f._[0], '<id>')) });
    case 'render-wait': return call('render-wait', { id: Number(need(f._[0], '<id>')), seconds: Number(f._[1] || 100) });
    case 'handoff': return call('handoff', { text: need(f._.join(' '), '"text"') });
    case 'taste': return call('taste', { text: need(f._.join(' '), '"text"') });
    case 'log': return call('log', { name: need(f._[0], 'EVENT'), details: f._.slice(1).join(' ') });
    case 'needs-you': return call('needs-you', { text: need(f._.join(' '), '"what you need"') });
    case 'propose-check': return call('propose-check', { title: f.title, how: f.how, example: f.example, work: f.work, same_as: f['same-as'] });
    case 'files': return call('files', {});
    case 'sheet': {
      const out = resolve(cwd, typeof f.out === 'string' ? f.out : 'sheet.jpg');
      if (!f._.length) throw new Error(`mfx sheet <image...>\n\n${USAGE}`);
      if (!sheetFor(f._.map((x) => resolve(cwd, x)), out, { cols: f.cols ? Number(f.cols) : undefined })) throw new Error('could not make the sheet (is ffmpeg installed, and are the files images?)');
      console.log(out);
      return undefined;
    }
    case 'song': return songCmd(f, call, need, env, cwd);
    case 'canvas': return call('canvas-sync', {});
    case 'edits': return call('edits', {});
    case 'edit': {
      const [sub, edit, ...words] = f._;
      if (sub === 'done') return call('edit-done', { edit: need(edit, '<E001>'), note: words.join(' ') });
      if (sub === 'fail') return call('edit-fail', { edit: need(edit, '<E001>'), note: need(words.join(' '), '"why"') });
      throw new Error(`mfx edit done|fail <E001> ["note"]\n\n${USAGE}`);
    }
    case undefined: case 'help': case '--help': case '-h':
      console.log(USAGE);
      return undefined;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

// The song's rev as this session last read it: every write is based on it, so an owner's change in between is caught.
// named by a hash of the token, never by part of it: the temp folder is shared with every program on this machine
const revFile = (env) => join(tmpdir(), `mfx-song-rev-${createHash('sha256').update(String(env.MFX_TOKEN || 'x')).digest('hex').slice(0, 16)}`);
const remember = (env, out) => { try { if (out && Number.isInteger(out.rev)) writeFileSync(revFile(env), String(out.rev)); } catch { /* best effort */ } return out; };
const lastRev = (env) => { try { return Number(readFileSync(revFile(env), 'utf8')); } catch { return null; } };
const barsOf = (v, need) => { const m = String(need(v, '--bars 3-4')).match(/^(\d+)(?:-(\d+))?$/); if (!m) throw new Error('--bars looks like 3-4 (inside the section)'); return [Number(m[1]), Number(m[2] || m[1])]; };

async function songCmd(f, call, need, env, cwd) {
  const [sub, a, b] = f._;
  const edit = typeof f.edit === 'string' ? f.edit : null;
  const part = typeof f.part === 'string' ? f.part : null;
  switch (sub) {
    case undefined: return remember(env, await call('song', {}));
    case 'show': return remember(env, await call('song-show', { section: need(a, '<section>'), part, bars: f.bars ? barsOf(f.bars, need) : null }));
    case 'strudel':
      if (b) return remember(env, await call('song-strudel-put', { section: a, part: b, bars: barsOf(f.bars, need), code: readFileSync(resolve(cwd, need(f.file, '--file <bars.strudel.js>')), 'utf8'), edit, rev: lastRev(env) }));
      return remember(env, await call('song-strudel', { section: a || null, part }));
    case 'notes': {
      const notes = readJsonFile(need(f.file, '--file <notes.json>'), cwd);
      return remember(env, await call('song-notes', { section: need(a, '<section>'), part: need(b, '<part>'), bars: barsOf(f.bars, need), notes: Array.isArray(notes) ? notes : notes.notes, edit, rev: lastRev(env) }));
    }
    case 'ops': { const ops = readJsonFile(need(a, '<ops.json>'), cwd); return remember(env, await call('song-ops', { ops: Array.isArray(ops) ? ops : ops.ops, edit, rev: lastRev(env) })); }
    case 'import': return remember(env, await call('song-import', {}));
    case 'version': return call('song-version', { why: f._.slice(1).join(' ') });
    default: throw new Error(`mfx song [show|strudel|notes|ops|import|version] …\n\n${USAGE}`);
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
