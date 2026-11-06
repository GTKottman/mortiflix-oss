// The Music stage's score (owner, 2026-10-18: "Music would obviously have strudel, and the MIDI stuff would be pasted to
// the animatic"): the Strudel the score is written in, and its MIDI notes in seconds on the animatic's clock, so the app
// can draw them under the animatic. Read-only; the song lane and the music skill change the score.
import { existsSync, readFileSync } from 'node:fs';
import { songPaths, songView } from '../song-store.mjs';

// Ticks → seconds over the song's tempo map (each change takes effect at its tick).
export function tickClock(song) {
  const ppq = song.ppq || 960;
  const tempo = [...(song.tempo?.length ? song.tempo : [{ tick: 0, bpm: 120 }])].sort((a, b) => a.tick - b.tick);
  const offset = song.offsetSec || 0;
  return (tick) => {
    let sec = offset;
    for (let i = 0; i < tempo.length; i++) {
      const from = tempo[i].tick;
      const to = i + 1 < tempo.length ? Math.min(tempo[i + 1].tick, tick) : tick;
      if (to <= from) break;
      sec += ((to - from) / ppq) * (60 / tempo[i].bpm);
    }
    return sec;
  };
}

export function musicScore(root, id) {
  const sp = songPaths(root, id);
  const file = [sp.strudel, sp.score].find((f) => existsSync(f)) || null;
  const view = songView(root, id);
  const song = view?.song || null;
  const out = { strudel: file ? { file, text: readFileSync(file, 'utf8') } : null, draft: Boolean(view?.draft), channels: [], notes: [], sections: [], bpm: null };
  if (!song) return out;
  const at = tickClock(song);
  out.bpm = song.tempo?.[0]?.bpm ?? null;
  out.channels = song.channels.filter((c) => c.kind !== 'audio').map((c) => ({ id: c.id, name: c.name, colour: c.colour || null, midi: c.midiChannel }));
  const patterns = Object.fromEntries((song.patterns || []).map((p) => [p.id, p]));
  for (const item of (song.playlist?.items || []).filter((i) => i.kind === 'pattern').sort((a, b) => a.at.tick - b.at.tick)) {
    const p = patterns[item.ref];
    if (!p) continue;
    const t0 = item.at.tick;
    out.sections.push({ id: p.id, name: p.name || p.id, start_sec: Math.round(at(t0) * 1000) / 1000, end_sec: Math.round(at(t0 + (item.len || 0)) * 1000) / 1000 });
    for (const [ch, notes] of Object.entries(p.notes || {})) {
      for (const n of notes) {
        if (item.len && n.t >= item.len) continue;
        const a = at(t0 + n.t);
        out.notes.push({ ch, key: n.key, start_sec: Math.round(a * 1000) / 1000, dur_sec: Math.round((at(t0 + n.t + n.len) - a) * 1000) / 1000, vel: n.vel ?? 0.8 });
      }
    }
  }
  return out;
}
