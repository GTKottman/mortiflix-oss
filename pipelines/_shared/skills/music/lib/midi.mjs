// A Type-1 Standard MIDI File (one track per part, on its role's channel) from tracks of notes in beats (480 ticks per beat), and a small parser for tests.
const PPQ = 480;

function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, Buffer.from(data)]);
};
const text = (type, s) => { const b = [...Buffer.from(String(s).slice(0, 120), 'utf8')]; return [0, 0xff, type, ...vlq(b.length), ...b]; };

// meter "6/8" → time signature 6/8; markers [{ beat, text }] go on the conductor track (section names, hit points).
export function writeMidi({ bpm, tracks, meter = '4/4', markers = [] }) {
  const tempo = Math.round(60000000 / bpm);
  const [num, den] = String(meter).split('/').map(Number);
  const conductor = [...text(0x03, 'tempo'), 0, 0xff, 0x51, 3, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff, 0, 0xff, 0x58, 4, num || 4, Math.log2(den || 4), 24, 8];
  let at = 0;
  for (const m of [...markers].sort((a, b) => a.beat - b.beat)) {
    const tick = Math.max(0, Math.round(m.beat * PPQ));
    conductor.push(...vlq(tick - at), ...text(0x06, m.text).slice(1));
    at = tick;
  }
  conductor.push(0, 0xff, 0x2f, 0);
  const out = [chunk('MTrk', conductor)];
  const melodic = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];   // channel 10 (index 9) is drums
  let next = 0;
  for (const t of tracks) {
    const ch = t.kind === 'drums' ? 9 : Number.isInteger(t.channel) && t.channel !== 10 ? t.channel - 1 : melodic[next++ % melodic.length];
    const events = [];
    for (const n of t.notes) {
      const on = Math.round(n.start * PPQ);
      const off = Math.max(on + 1, Math.round((n.start + n.dur) * PPQ));
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
      events.push({ tick: on, data: [0x90 | ch, n.pitch, vel], order: 1 }, { tick: off, data: [0x80 | ch, n.pitch, 0], order: 0 });
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const bytes = [...text(0x03, t.name)];
    let last = 0;
    for (const e of events) { bytes.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
    bytes.push(0, 0xff, 0x2f, 0);
    out.push(chunk('MTrk', bytes));
  }
  const header = Buffer.alloc(6);
  header.writeUInt16BE(1, 0); header.writeUInt16BE(out.length, 2); header.writeUInt16BE(PPQ, 4);
  return Buffer.concat([chunk('MThd', header), ...out]);
}

// Minimal reader (tests): { format, ppq, tracks: [{ name, notes: [{ pitch, start, dur, velocity, channel }] }], tempo }.
export function readMidi(buf) {
  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('not a MIDI file');
  const format = buf.readUInt16BE(8); const ntr = buf.readUInt16BE(10); const ppq = buf.readUInt16BE(12);
  let pos = 14; const tracks = []; let tempo = null;
  for (let t = 0; t < ntr; t += 1) {
    const len = buf.readUInt32BE(pos + 4); let p = pos + 8; const end = p + len; pos = end;
    let tick = 0; let status = 0; const open = new Map(); const track = { name: '', notes: [] };
    const readVlq = () => { let v = 0; let b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (p < end) {
      tick += readVlq();
      let s = buf[p];
      if (s & 0x80) { status = s; p += 1; } else s = status;
      if (s === 0xff) {
        const type = buf[p++]; const l = readVlq();
        if (type === 0x03) track.name = buf.toString('utf8', p, p + l);
        if (type === 0x51) tempo = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
        p += l;
      } else {
        const kind = s & 0xf0; const ch = s & 0x0f; const a = buf[p++]; const b = buf[p++];
        if (kind === 0x90 && b > 0) open.set(`${ch}:${a}`, { tick, vel: b });
        else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
          const o = open.get(`${ch}:${a}`);
          if (o) { track.notes.push({ pitch: a, start: o.tick / ppq, dur: (tick - o.tick) / ppq, velocity: o.vel / 127, channel: ch }); open.delete(`${ch}:${a}`); }
        }
      }
    }
    tracks.push(track);
  }
  return { format, ppq, tempo, tracks };
}
