#!/usr/bin/env node
// One-off (2026-11-02, Dir3 61dc): Claude rows of the v3 projects were booked to stage "artcraft" long before Finish,
// because the ledger took "the last step" when nothing was being made (svc/ledger.mjs currentStage, now fixed). This
// re-books those rows from the project's own history: a session that worked on canvas edits goes to the stage of the
// edited pieces (E001 on a beat = Script); anything else goes to the step the owner was on at that time (the latest
// step submitted, sent back or approved; after an approval, the next step). Rows after the Artcraft step really
// started keep "artcraft". A backup of the ledger is written first.
//
//   node tools/rebook-ledger.mjs [studio root, default ~/Mortiflix] [--dry]
import { copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { projectPipeline } from '../src/projects.mjs';
import { stageSet, stageOf } from '../src/svc/stages.mjs';
import { stageOfKind } from '../src/svc/ledger.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const root = args.find((a) => !a.startsWith('--')) || join(homedir(), 'Mortiflix');
const ledger = join(root, 'state', 'usage-ledger.jsonl');
const jsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const ms = (s) => Date.parse(s);
const runStart = (runId) => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(runId); return m ? ms(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null; };

// Every v3 project: its stage set, steps in order, events, edits (with when each was asked and done).
const projects = new Map();
for (const id of readdirSync(join(root, 'state'))) {
  if (!existsSync(join(root, 'state', id, 'project.json'))) continue;
  let pipeline; try { pipeline = projectPipeline(root, id); } catch { continue; }
  if (pipeline.stage_set !== 'v3') continue;
  const set = stageSet(pipeline);
  const events = jsonl(join(root, 'state', id, 'events.jsonl'));
  const edits = (() => { try { return JSON.parse(readFileSync(join(root, 'state', id, 'canvas', 'edits.json'), 'utf8')).edits || []; } catch { return []; } })();
  const doneAt = new Map(events.filter((e) => e.event === 'EDIT_DONE').map((e) => [String(e.details).split(' ')[0], ms(e.t)]));
  const artcraftFrom = Math.min(...events.filter((e) => e.step === 'artcraft').map((e) => ms(e.t)), Infinity);
  projects.set(id, { set, steps: pipeline.steps, events, edits: edits.map((e) => ({ ...e, from: ms(e.at), to: doneAt.get(e.id) ?? Infinity })), artcraftFrom });
}

function stageAt(p, t, runId) {
  // a session working on canvas edits: the edited pieces' stage
  const s0 = runId ? runStart(runId) : null;
  if (s0 !== null) {
    const e = p.edits.find((x) => x.from <= s0 + 5000 && x.to >= s0 && stageOfKind(p.set, x.kind) >= 0);
    if (e) return p.set.keys[stageOfKind(p.set, e.kind)];
  }
  // else the step the owner was on then
  const last = p.events.filter((e) => e.step && ['SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED'].includes(e.event) && ms(e.t) <= t).at(-1);
  if (!last) return p.set.keys[0];
  let i = p.steps.findIndex((s) => s.key === last.step);
  if (last.event === 'APPROVED' && i >= 0 && i < p.steps.length - 1) i++;
  const idx = i >= 0 ? stageOf(p.steps[i], p.set) : -1;
  return idx >= 0 ? p.set.keys[idx] : null;
}

const rows = jsonl(ledger);
let moved = 0;
const out = rows.map((r) => {
  const p = projects.get(r.project);
  if (!p || r.provider !== 'claude' || r.stage !== 'artcraft' || ms(r.at) >= p.artcraftFrom) return r;
  const runId = r.kind === 'session' ? String(r.id || '').split(':')[2] : null;
  const stage = stageAt(p, ms(r.at), runId);
  if (!stage || stage === r.stage) return r;
  moved++;
  return { ...r, stage, rebooked_from: r.stage };
});
console.log(`${moved} of ${rows.length} rows re-booked (${[...projects.keys()].join(', ')})`);
if (!dry && moved) {
  const backup = `${ledger}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(ledger, backup);
  writeFileSync(ledger, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`backup: ${backup}`);
}
