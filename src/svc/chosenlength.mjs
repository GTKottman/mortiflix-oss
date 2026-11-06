// The length the owner chose on New project ("60 s", "1 min", "1 min 30 s"), in seconds, for the Script screen's
// "of 1:00 chosen". A range ("30 to 120 s") or anything unreadable is null: the screen then adds up the scenes' plans.
import { loadProject } from '../projects.mjs';

export function parseLength(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t || /\bto\b|–|-|\bor\b/.test(t)) return null;
  const m = t.match(/^(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?))?\s*(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const sec = Math.round(Number(m[1] || 0) * 60 + Number(m[2] || 0));
  return sec > 0 ? sec : null;
}

export function chosenSec(root, id) {
  try { return parseLength(loadProject(root, id).intake?.answers?.length); } catch { return null; }
}
