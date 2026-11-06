// 32-bit float WAV, written whole: lossless from the source to the mix.
import { writeFileSync } from 'node:fs';

export function writeWav(file, channels, rate) {
  const n = channels[0].length; const ch = channels.length;
  const b = Buffer.alloc(44 + n * ch * 4);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * ch * 4, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * ch * 4, 28); b.writeUInt16LE(ch * 4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(n * ch * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { b.writeFloatLE(channels[c][i], o); o += 4; }
  writeFileSync(file, b);
}
