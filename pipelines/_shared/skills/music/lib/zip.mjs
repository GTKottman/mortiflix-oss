// A plain .zip (stored, not compressed: MIDI and text are small, WAVs barely compress) with no dependencies. The music
// engine zips the MIDI pack with it; the studio uses it for the MIDI download and for sharing pipelines (src/zip.mjs).
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

// files: [{ name: 'midi/01-bass.mid', data: Buffer }] → the zip as a Buffer.
export function zip(files) {
  const local = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name.split(sep).join('/'), 'utf8'); const data = Buffer.from(f.data); const crc = crc32(data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(0x21, 12); // date 1980-01-01
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// Every file under dir, as zip entries named prefix/<path inside dir>.
export function dirEntries(dir, prefix = '') {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name); const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ name: join(prefix, relative(dir, full)), data: readFileSync(full) });
    }
  };
  walk(dir);
  return out;
}

// Reads a zip (stored or deflated entries) → [{ name, data }]. Names are returned as written; callers check them.
export function unzip(buf, { maxBytes = 200 * 1024 * 1024 } = {}) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = []; let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32); const lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    total += usize; if (total > maxBytes) throw new Error('the zip unpacks to more than allowed');
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: usize }) : null;
    if (!data) throw new Error(`${name}: unsupported compression`);
    out.push({ name, data });
  }
  return out;
}
