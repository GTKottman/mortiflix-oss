#!/usr/bin/env node
// Replay mode's stand-in for the `claude` command (src/replay.mjs sets config.claudeBin to this file). It never calls
// Claude: every call is logged and answered "no recording" with zero tokens, so a Claude call replay doesn't cover shows
// up as a plain failure in the beta test instead of spending anything.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

function answer(prompt) {
  const pack = process.env.MFX_REPLAY;
  if (!pack) return null;
  let j = {};
  try { j = JSON.parse(readFileSync(join(pack, 'replay.json'), 'utf8')); } catch { return null; }
  if (/^You score a [\d.]+ second narrated video/.test(prompt)) {
    const f = j.claude?.['music-plan'] && join(pack, j.claude['music-plan']);
    return f && existsSync(f) ? readFileSync(f, 'utf8') : null;
  }
  if (/^You are the Mortiflix assistant inside a video app/.test(prompt)) return 'Replay mode: the chat answers from recordings only, so nothing new is written here.';
  return null;
}

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0 (Claude Code, Mortiflix replay stand-in)'); process.exit(0); }
// setup's login check: the stand-in is "logged in" as replay (it never calls Claude, so there's nothing to log in to)
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'replay', apiProvider: 'none' })); process.exit(0); }
const root = process.env.MORTIFLIX_STUDIO;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', done);
process.stdin.on('error', done);
setTimeout(done, 2000).unref();
let finished = false;
function done() {
  if (finished) return;
  finished = true;
  const prompt = input || args[args.indexOf('-p') + 1] || '';
  if (root) {
    try {
      mkdirSync(join(root, 'run', 'replay'), { recursive: true });
      appendFileSync(join(root, 'run', 'replay', 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), kind: 'claude-call', args: args.filter((a) => a.length < 200).slice(0, 30), prompt_head: String(prompt).slice(0, 300) })}\n`);
    } catch { /* the log is a help */ }
  }
  // the few calls replay has an answer for: the music plan (the pack's recorded plan) and the chat (a plain note)
  const recorded = answer(String(prompt));
  const base = { type: 'result', session_id: 'replay', num_turns: 0, duration_ms: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  if (recorded !== null) {
    let structured;
    try { structured = JSON.parse(recorded); } catch { structured = undefined; }
    process.stdout.write(`${JSON.stringify({ ...base, subtype: 'success', is_error: false, result: recorded, ...(structured ? { structured_output: structured } : {}) })}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({ ...base, subtype: 'error_during_execution', is_error: true, result: 'replay: no recorded answer for this Claude call (replay mode never calls Claude)' })}\n`);
  process.exit(1);
}
