// Soundtrack v1, the effects: from an SFX pack (packs/sfx/<id>/sounds.json, every file measured: its hit point,
// length, tail). Each cut gets the sound that matches its transition, its hit on the middle of the transition (start
// the file at moment - hit_sec); the call to action gets a soft chime on its first word. Medium for cuts, soft under
// words: the mix (Dubstage) levels them against the voice by strength.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FOR_TRANSITION = [
  [/portal|zoom|warp|tunnel/i, 'warp'],
  [/morph|orbit|melt|liquid/i, 'whoosh-slow'],
  [/match|anchor/i, 'slide'],
  [/line|wipe|slide|push/i, 'whoosh-fast'],
];

export function loadPack(dir) {
  const f = join(dir, 'sounds.json');
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return { dir, sounds: j.sounds || [] };
}

// cuts: [{ cut, t_sec (the moment it lands), frames, what }]; lastBeatStart: the call to action's first word (s)
export function planEffects({ pack, cuts, fps = 30, lastBeatStart = null }) {
  const find = (sound, strength) => pack.sounds.find((s) => s.sound === sound && s.version === strength);
  const out = [];
  for (const c of cuts) {
    const kind = (FOR_TRANSITION.find(([re]) => re.test(c.what)) || [null, 'whoosh-fast'])[1];
    const s = find(kind, 'medium');
    if (!s) continue;
    const moment = c.t_sec - (c.frames || 0) / fps / 2; // the middle of the transition
    out.push({ file: join(pack.dir, s.file), sound: s.id, at: +Math.max(0, moment - s.hit_sec).toFixed(3), moment: +moment.toFixed(3), strength: 'medium', label: `${s.id} on cut ${c.cut}`, why: `${c.what}: ${s.use_for}` });
  }
  // the call to action's chime, unless a cut's sound already lands there (two sounds at once muddy both)
  if (lastBeatStart !== null && !out.some((e) => Math.abs(e.moment - lastBeatStart) < 1.5)) {
    const s = find('chime', 'soft');
    if (s) out.push({ file: join(pack.dir, s.file), sound: s.id, at: +Math.max(0, lastBeatStart - s.hit_sec).toFixed(3), moment: lastBeatStart, strength: 'soft', label: `${s.id} on the call to action`, why: s.use_for });
  }
  return out;
}
