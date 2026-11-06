// Fix it (plan 30). A short fixed list, never "make it work". Free and local: no Claude call, no paid API, no takeover,
// nothing deleted. Cases kept after the owner's decisions of 2026-11-01:
//   tools   (2) a tool check failed (shown only when it fails; Fix it only once the cached answer is over 5 min old)
//   tablet  (3) the app settled a scene, the tablet still shows it open: the app wins
//   paused  (4) "Needs you" for a stopped / rate-limit / sign-in pause whose cause is gone: re-check, then resume
// Case 1 (lost service) is the bridge's and the page's. Cases 5-8 were dropped.
import { listProjects, loadProject, event } from '../projects.mjs';
import { loadConfig } from '../studio.mjs';
import { sceneGet } from './lessons.mjs';
import { closeOnApp } from './videonotes.mjs';

export const CASES = ['paused', 'tablet', 'tools']; // worst first
export const STALE_MS = 300_000;
export const RATE_WAIT_MS = 300_000; // a rate-limit pause counts as over after this long
const RECHECKABLE = new Set(['stopped', 'rate-limit', 'login']);
const iso = (ms) => new Date(ms).toISOString();

// ---- 4: paused for a reason that is gone ----
// Free re-test of one cause. `loggedIn`: true/false/null (unknown). Returns {clear, why}.
function causeState(np, loggedIn, now = Date.now()) {
  const cause = np?.cause;
  if (np?.by_you) return { clear: false, why: 'You paused this one yourself.' };
  if (!RECHECKABLE.has(cause)) return { clear: false, why: cause === 'billing' ? 'A paid service refused the call. Only you can check the account.' : cause === 'gave-up' || cause === 'needs-ai' ? 'This needs a decision: Resume, or let the AI take over.' : 'This pause has no free re-check.' };
  if (cause === 'stopped') return { clear: true, why: 'The stop is over.' };
  if (cause === 'rate-limit') {
    const left = Date.parse(np.at || '') + RATE_WAIT_MS - now;
    return left <= 0 ? { clear: true, why: 'The wait is over.' } : { clear: false, why: `The service said slow down. Try again in ${Math.ceil(left / 60_000)} min.` };
  }
  if (loggedIn === true) return { clear: true, why: 'Claude Code is signed in again.' };
  return { clear: false, why: loggedIn === false ? 'Claude Code is still signed out. Link it again.' : 'Could not tell whether Claude Code is signed in.' };
}
const loginOf = (v) => (v?.claude?.logged_in === undefined ? null : v.claude.logged_in);

export async function recheck(root, id, { cache, now = Date.now() } = {}) {
  const p = loadProject(root, id);
  if (p.state !== 'paused' || !p.needs_you) return { resumed: false, clear: false, why: 'Nothing is paused here.' };
  let li = null;
  if (p.needs_you.cause === 'login') li = loginOf(await cache.get('heavy', { force: true })); // `claude auth status`: free
  const c = causeState(p.needs_you, li, now);
  if (!c.clear) return { resumed: false, clear: false, cause: p.needs_you.cause || null, why: c.why };
  const { resume } = await import('../gates.mjs');
  resume(root, id);
  event(root, id, { event: 'RESUMED', actor: 'studio', details: `Re-checked "${p.needs_you.cause}": ${c.why} Resumed.` });
  return { resumed: true, clear: true, cause: p.needs_you.cause, why: c.why };
}

// ---- 3: tablet still open for a scene the app settled ----
function openTablets(root, id) {
  let g; try { g = sceneGet(root, id); } catch { return []; }
  return g.scenes.filter((s) => s.tablet && !s.tablet.handled && s.tablet.status !== 'done' && s.state !== 'review').map((s) => s.beat);
}
export function reconcileTablet(root, id) {
  const closed = [];
  for (const beat of openTablets(root, id)) if (closeOnApp(root, id, beat, 'scene')) closed.push(beat);
  return { closed: closed.length, scenes: closed };
}

// ---- 2: a tool check failed ----
function toolProblems(root, v) {
  if (!v) return [];
  const out = [];
  const demo = loadConfig(root).backend === 'demo';
  if (!demo && v.claude && v.claude.found === false) out.push('Claude Code is not installed.');
  else if (!demo && v.claude?.logged_in === false) out.push('Claude Code is signed out.');
  if (v.tools?.ffmpeg && v.tools.ffmpeg.ok === false) out.push('ffmpeg is missing, so nothing can render.');
  return out;
}

// FAST and read-only: cached values only, files only. [{case, text, fix|null, since}] worst first.
export function check(root, { project = null, cache, now = Date.now() } = {}) {
  const found = [];
  const heavy = cache.peek('heavy');
  const ids = project ? [project] : listProjects(root).filter((p) => p.state !== 'delivered' && p.state !== 'cancelled').map((p) => p.id);
  for (const id of ids) {
    let p; try { p = loadProject(root, id); } catch { continue; }
    if (p.state === 'paused' && p.needs_you && RECHECKABLE.has(p.needs_you.cause) && !p.needs_you.by_you) {
      const c = causeState(p.needs_you, p.needs_you.cause === 'login' ? loginOf(heavy) : null, now);
      if (c.clear) found.push({ case: 'paused', project: id, text: `"${p.title || id}" is paused for a reason that is gone. ${c.why}`, fix: { type: 'sync.fix', params: { case: 'paused', project: id } }, since: p.needs_you.at || null });
    }
  }
  for (const id of ids) {
    const open = openTablets(root, id);
    if (open.length) found.push({ case: 'tablet', project: id, text: `The tablet still shows ${open.length === 1 ? 'a scene' : `${open.length} scenes`} to review that you settled in the app.`, fix: { type: 'sync.fix', params: { case: 'tablet', project: id } }, since: null });
  }
  const probs = toolProblems(root, heavy);
  if (probs.length) {
    const at = cache.at('heavy');
    found.push({ case: 'tools', project: null, text: probs.join(' '), fix: now - at > STALE_MS ? { type: 'sync.fix', params: { case: 'tools' } } : null, since: at ? iso(at) : null });
  }
  found.sort((a, b) => CASES.indexOf(a.case) - CASES.indexOf(b.case));
  return found.map(({ project, ...r }) => (project ? { ...r, project } : r));
}

// The one way in for the button. Only the remaining case names. One action, then a plain sentence.
export async function fix(root, { name, project = null, cache, emit, chatRow, resume }) {
  if (!CASES.includes(name)) { const e = new Error(`not a Fix it case: ${name}. Cases: ${CASES.join(', ')}`); e.code = 'bad_request'; throw e; }
  let r;
  if (name === 'tools') {
    const v = await cache.get('heavy', { force: true });
    const probs = toolProblems(root, v);
    r = { done: true, text: probs.length ? `Checked the tools again. Still wrong: ${probs.join(' ')}` : 'Checked the tools again. They are all fine.' };
  } else {
    if (!project) { const e = new Error('which project?'); e.code = 'no_project'; throw e; }
    if (name === 'tablet') {
      const x = reconcileTablet(root, project);
      r = { done: x.closed > 0, text: x.closed ? `Closed ${x.closed} scene${x.closed === 1 ? '' : 's'} on the tablet. Notes already there were kept.` : 'Nothing was open on the tablet.' };
    } else {
      const x = await recheck(root, project, { cache });
      r = { done: x.resumed, text: x.resumed ? `${x.why} Resumed.` : x.why };
      if (x.resumed) resume?.();
    }
  }
  if (project) {
    try { event(root, project, { event: 'SYNC_FIX', actor: 'you', details: `${name}: ${r.text}` }); } catch { /* project gone */ }
    try { chatRow?.(project, { role: 'system', text: `Fix it: ${r.text}` }); } catch { /* no chat */ }
  }
  return r;
}
