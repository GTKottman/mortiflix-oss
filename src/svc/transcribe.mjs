// notes.transcribe {note | audio, project?}: a spoken note's recording turned into words for the owner to check, with
// faster-whisper on this machine (free, offline). It never sits on the request chain: the reply is {job} at once, then
// the `notes.transcribed` event {job, note, text, language} or {job, note, error}. The words are also kept next to the
// recording (<audio>.txt) so asking again is instant. Without faster-whisper the event says how to install it.
//   python: MFX_WHISPER_PYTHON, else an existing tools/qwen-tts venv (left from the removed local voice), else python3. model: MFX_WHISPER_MODEL or "base".
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { projectPaths } from '../projects.mjs';
import { isInside, readJsonList } from '../studio.mjs';
import { toolsDir } from '../setup.mjs';

const localPython = (dir) => join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

const RUNNER = new URL('../voice/whisper_runner.py', import.meta.url).pathname;
const readList = readJsonList; // studio.mjs: [] only when missing; a damaged file is an error, never wiped

export function whisperPython(root) {
  if (process.env.MFX_WHISPER_PYTHON) return process.env.MFX_WHISPER_PYTHON;
  const q = localPython(join(toolsDir(root), 'qwen-tts'));
  return existsSync(q) ? q : 'python3';
}

// Default runner: spawn the python script. Tests pass their own `run(audio) -> {text, language}`.
export function runWhisper(root, audio, { timeoutMs = 300_000 } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(whisperPython(root), [RUNNER, audio, process.env.MFX_WHISPER_MODEL || 'base'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = '';
    const timer = setTimeout(() => { p.kill(); fail(new Error('listening took too long and was stopped')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    p.on('error', (e) => { clearTimeout(timer); fail(new Error(`could not start Python: ${e.message}`)); });
    p.on('close', () => {
      clearTimeout(timer);
      let r; try { r = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ }
      if (r?.ok) ok(r);
      else fail(new Error(/faster_whisper|No module/.test(`${r?.error || ''}${err}`) ? 'faster-whisper is not installed (pip install faster-whisper into the Python the studio uses, or set MFX_WHISPER_PYTHON)' : r?.error || err.trim() || 'no result'));
    });
  });
}

// Which file, and which saved note it belongs to.
export function resolveAudio(root, id, p) {
  const state = projectPaths(root, id).state;
  if (p?.note) {
    const n = readList(join(state, 'notes', 'notes.json')).find((x) => x.id === String(p.note));
    if (!n) throw new Error(`no note ${p.note}`);
    if (!n.audio) throw new Error('that note has no recording');
    return { audio: insideState(state, n.audio), note: n.id };
  }
  if (!p?.audio) throw new Error('notes.transcribe needs a note or an audio file');
  return { audio: insideState(state, String(p.audio)), note: null };
}

// Only the project's own files: a recording under its state folder. Both sides are real paths (`..` and links
// resolved), then compared with isInside, so "<state>/x/../../etc/foo" or a link out of the folder is refused.
function insideState(state, asked) {
  const f = isAbsolute(asked) ? asked : resolve(state, asked);
  let real, top;
  try { real = realpathSync(f); top = realpathSync(state); } catch { throw new Error('the recording is not there'); }
  if (!isInside(top, real) || real === top) throw new Error('audio must be a file inside the project');
  return real;
}

export function transcribeHandlers({ root, emit, needProject, bad, run = null }) {
  let next = 1;
  return {
    'notes.transcribe': (p) => {
      const id = needProject(p);
      let r;
      try { r = resolveAudio(root, id, p); } catch (e) { bad(e.message); }
      if (!existsSync(r.audio)) bad('the recording is not there');
      const job = next++;
      const side = `${r.audio}.txt`;
      const done = (data) => { try { emit('notes.transcribed', { job, project: id, note: r.note, audio: r.audio, ...data }); } catch { /* gone */ } };
      (async () => {
        if (existsSync(side) && !p?.force) { done({ text: readFileSync(side, 'utf8'), cached: true }); return; }
        try {
          const t = await (run ? run(r.audio) : runWhisper(root, r.audio));
          const text = String(t.text || '').trim();
          writeFileSync(side, text);
          done({ text, language: t.language || null });
        } catch (e) { done({ error: e.message }); }
      })();
      return { job, note: r.note };
    },
  };
}
