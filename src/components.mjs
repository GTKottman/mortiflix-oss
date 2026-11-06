// The installer's components: the tools Mortiflix uses, offered when Mortiflix Studio is installed (and later in
// first-run setup), each with what it's for and its size. No install logic of its own: every component is one of
// setup.mjs's tools, installed into the studio (tools/, the studio's own Blender profile) or as the user's own tool
// (uv), never system-wide. A component that fails or is skipped never fails the rest. No local AI models since
// 2026-11-01: voice and music come from ElevenLabs, pictures are drawn in code.
import { setupStatus, installTool, TOOL_INFO } from './setup.mjs';

// In install order (the 3D toolkits need Blender first). `on`: ticked by default. `needs`: shown beside it.
export const COMPONENTS = [
  { id: 'kinetograph', on: true, for: 'renders every 2D shot, style frame and animatic on your graphics card, with no browser (built in)', needs: 'installed with the app' },
  { id: 'blender', on: true, for: '3D shots: Blender renders the scenes the AI builds' },
  { id: 'blender-addons', on: true, for: '3D motion design: MoBlend, Nova FX, Camera, Animate, Math, Circuits and Camera Flight, in the studio\'s own Blender profile (never your own)', after: 'blender' },
  { id: 'chrome', on: true, for: 'renders the music (Strudel) (an existing Chrome or Chromium is reused)' },
  { id: 'strudel', on: true, for: 'the music step: it writes and renders the score' },
  { id: 'transitions', on: true, for: 'every cut: 50 designed transitions the AI picks from' },
  { id: 'uv', on: true, for: 'runs browser-harness (the asset sites) with its own Python' },
];
export const COMPONENT_IDS = COMPONENTS.map((c) => c.id);
export const DEFAULT_IDS = COMPONENTS.filter((c) => c.on).map((c) => c.id);

// Each component with its name, what it is, where it goes, its size, its default and whether it's here now.
export async function componentsStatus(root) {
  let st = {};
  try { st = await setupStatus(root); } catch (e) { st = { error: e.message }; }
  return COMPONENTS.map((c) => {
    const info = TOOL_INFO[c.id] || {};
    const s = st[c.id] || {};
    return { id: c.id, name: info.name || c.id, for: c.for, what: info.what || '', where: info.where || '', size: info.size || '', default: c.on, needs: c.needs || null,
      installed: typeof s.installed === 'boolean' ? s.installed : s.ok === true, detail: s.detail || (st.error ? `status unavailable: ${st.error}` : ''), path: s.path || null };
  });
}

// "default", "all", "none" or a comma list -> ids in install order (unknown ids are an error, so a typo isn't skipped).
export function parseComponents(spec) {
  const raw = String(spec ?? 'default').trim().toLowerCase();
  if (raw === 'default' || raw === '') return [...DEFAULT_IDS];
  if (raw === 'all') return [...COMPONENT_IDS];
  if (raw === 'none') return [];
  const want = raw.split(/[\s,]+/).filter(Boolean);
  const unknown = want.filter((w) => !COMPONENT_IDS.includes(w));
  if (unknown.length) throw new Error(`unknown component ${unknown.join(', ')} (${COMPONENT_IDS.join(', ')})`);
  return COMPONENT_IDS.filter((id) => want.includes(id));
}

// Installs the chosen ones in order. `onEvent({id, phase: 'start'|'line'|'done'|'failed'|'skipped', ...})`.
// Never throws for a component: each result is {id, ok, detail|error, seconds}.
export async function installComponents(root, ids, { onEvent = () => {}, install = installTool } = {}) {
  const results = [];
  for (const id of parseComponents(ids.join(','))) {
    const c = COMPONENTS.find((x) => x.id === id);
    if (c.after && results.some((r) => r.id === c.after && !r.ok)) {
      const r = { id, ok: false, error: `skipped: ${c.after} didn't install`, seconds: 0 };
      onEvent({ id, phase: 'skipped', error: r.error });
      results.push(r);
      continue;
    }
    const t = Date.now();
    onEvent({ id, phase: 'start', name: TOOL_INFO[id]?.name || id, size: TOOL_INFO[id]?.size || '' });
    try {
      const s = await install(root, id, { log: (line) => onEvent({ id, phase: 'line', line: String(line).slice(0, 500) }) });
      const ok = s?.ok !== false && !s?.problems;
      const r = { id, ok, detail: s?.detail || 'installed', problems: s?.problems || null, seconds: Math.round((Date.now() - t) / 1000) };
      onEvent({ id, phase: ok ? 'done' : 'failed', ...r });
      results.push(r);
    } catch (e) {
      const r = { id, ok: false, error: e.message, seconds: Math.round((Date.now() - t) / 1000) };
      onEvent({ id, phase: 'failed', ...r });
      results.push(r);
    }
  }
  return results;
}
