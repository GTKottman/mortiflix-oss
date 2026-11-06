// The small default texture pack that ships with Mortiflix (owner, 2026-11-01: "a good amount of textures already
// pre-rendered in HTML that can be used just like by default. Not a huge amount ... half tones, gradients"). Every one is
// CSS (what a browser draws, and Kinetograph with it: checked by a real render), or a grain tile made by code here. No
// file to license, nothing remote. tex('<id>', {color, color2, scale, opacity, angle}) in video/src/pool.ts draws them.
//
// A texture: { id, name, use, tags, params: {name: default}, layers: [{image, size?, position?, blend?}], scaled: [param names
// that grow with `scale`], tile?: 'grain' }. "{name}" in a string is replaced by that param.
import { deflateSync } from 'node:zlib';

export const DEFAULT_TEXTURES = [
  { id: 'halftone-dots', name: 'Halftone dots', use: 'a quiet printed-dot ground behind type', tags: ['halftone', 'dots', 'print', 'ground'],
    params: { color: '#00000026', s: 18, r: 2.2 }, scaled: ['s', 'r'],
    layers: [{ image: 'radial-gradient(circle, {color} {r}px, transparent {r2}px)', size: '{s}px {s}px' }] },
  { id: 'halftone-dots-large', name: 'Halftone dots, large', use: 'bold dot pattern for an edge or a corner', tags: ['halftone', 'dots', 'bold', 'pop'],
    params: { color: '#00000033', s: 44, r: 8 }, scaled: ['s', 'r'],
    layers: [{ image: 'radial-gradient(circle, {color} {r}px, transparent {r2}px)', size: '{s}px {s}px' }] },
  { id: 'halftone-offset', name: 'Halftone dots, offset rows', use: 'comic-print dot grid', tags: ['halftone', 'dots', 'comic', 'print'],
    params: { color: '#00000030', s: 20, r: 3 }, scaled: ['s', 'r'],
    layers: [{ image: 'radial-gradient(circle, {color} {r}px, transparent {r2}px)', size: '{s}px {s}px' }, { image: 'radial-gradient(circle, {color} {r}px, transparent {r2}px)', size: '{s}px {s}px', position: '{h}px {h}px' }] },
  { id: 'halftone-lines', name: 'Halftone lines', use: 'diagonal hatching for a panel or a shadow', tags: ['halftone', 'lines', 'hatch', 'print'],
    params: { color: '#0000001f', s: 8, w: 2, angle: 45 }, scaled: ['s', 'w'],
    layers: [{ image: 'repeating-linear-gradient({angle}deg, {color} 0px, {color} {w}px, transparent {w}px, transparent {s}px)' }] },
  { id: 'gradient-linear', name: 'Linear gradient', use: 'two-colour ground, any angle', tags: ['gradient', 'ground', 'smooth'],
    params: { color: '#0b1d2e', color2: '#1f4a6e', angle: 160 }, scaled: [],
    layers: [{ image: 'linear-gradient({angle}deg, {color}, {color2})' }] },
  { id: 'gradient-glow', name: 'Radial glow', use: 'a soft light behind the subject', tags: ['gradient', 'glow', 'light', 'focus'],
    params: { color: '#ffffff40', color2: '#00000000', x: 50, y: 40 }, scaled: [],
    layers: [{ image: 'radial-gradient(ellipse at {x}% {y}%, {color} 0%, {color2} 65%)' }] },
  { id: 'gradient-vignette', name: 'Vignette', use: 'darkens the edges to hold the eye', tags: ['gradient', 'vignette', 'edge', 'focus'],
    params: { color: '#00000066', color2: '#00000000' }, scaled: [],
    layers: [{ image: 'radial-gradient(ellipse at 50% 50%, {color2} 55%, {color} 100%)' }] },
  { id: 'gradient-conic', name: 'Conic sweep', use: 'a turning light, dial or sunburst', tags: ['gradient', 'conic', 'sunburst', 'dial'],
    params: { color: '#ffffff33', color2: '#00000000', angle: 0 }, scaled: [],
    layers: [{ image: 'conic-gradient(from {angle}deg at 50% 50%, {color2}, {color}, {color2} 50%, {color}, {color2})' }] },
  { id: 'gradient-duotone-bands', name: 'Gradient bands', use: 'stepped two-colour bands, a poster ground', tags: ['gradient', 'bands', 'stripes', 'poster'],
    params: { color: '#00000014', s: 120, angle: 0 }, scaled: ['s'],
    layers: [{ image: 'repeating-linear-gradient({angle}deg, {color} 0px, {color} {hs}px, transparent {hs}px, transparent {s}px)' }] },
  { id: 'grid', name: 'Grid', use: 'a drafting grid for diagrams and data', tags: ['grid', 'lines', 'diagram', 'blueprint'],
    params: { color: '#ffffff1a', s: 64, w: 1.5 }, scaled: ['s', 'w'],
    layers: [{ image: 'linear-gradient({color} {w}px, transparent {w}px)', size: '{s}px {s}px' }, { image: 'linear-gradient(90deg, {color} {w}px, transparent {w}px)', size: '{s}px {s}px' }] },
  { id: 'scanlines', name: 'Scanlines', use: 'a screen, a camera, a surveillance look', tags: ['lines', 'scanlines', 'screen', 'crt'],
    params: { color: '#00000026', s: 4, w: 1 }, scaled: ['s', 'w'],
    layers: [{ image: 'repeating-linear-gradient(0deg, {color} 0px, {color} {w}px, transparent {w}px, transparent {s}px)' }] },
  { id: 'grain', name: 'Film grain', use: 'fine noise over a flat ground (tiled picture, 256 px)', tags: ['grain', 'noise', 'film', 'texture'],
    params: { s: 256 }, scaled: ['s'], tile: 'grain', layers: [] },
  { id: 'grain-coarse', name: 'Coarse grain', use: 'rough paper or stencil noise (tiled picture, 256 px)', tags: ['grain', 'noise', 'paper', 'rough', 'texture'],
    params: { s: 256 }, scaled: ['s'], tile: 'grain-coarse', layers: [] },
];

// A tiny seeded generator, so a grain tile is the same every build.
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };

// A grey noise tile, RGBA with a low alpha, so it lays over any ground. `cell` > 1 makes coarser noise.
export function grainPng({ size = 256, seed = 1, alpha = 38, cell = 1 } = {}) {
  const r = rng(seed);
  const n = Math.ceil(size / cell);
  const noise = Array.from({ length: n * n }, () => Math.floor(r() * 256));
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const v = noise[Math.floor(y / cell) * n + Math.floor(x / cell)];
      const o = row + 1 + x * 4;
      raw[o] = v; raw[o + 1] = v; raw[o + 2] = v; raw[o + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const GRAIN_TILES = { grain: { file: 'grain.png', opts: { size: 256, seed: 7, alpha: 34, cell: 1 } }, 'grain-coarse': { file: 'grain-coarse.png', opts: { size: 256, seed: 11, alpha: 44, cell: 3 } } };
