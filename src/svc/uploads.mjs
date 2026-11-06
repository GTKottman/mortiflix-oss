// The owner's own uploads (New project › Source material, kept in design/sources/), put into the look, stills and motion
// prompts (owner, 2026-11-04: an uploaded style HTML was never used; "It's just adding those assets to the prompt").
// Text files (HTML, CSS, SVG, Markdown, JSON, text) go in whole up to a cap; pictures go in by path, to open with Read.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const TEXT = new Set(['.html', '.htm', '.css', '.svg', '.md', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx']);
const PICTURE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const EACH = 40_000, ALL = 80_000;

export function uploads(work) {
  const dir = join(work, 'design', 'sources');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((name) => ({ name, file: join(dir, name), ext: extname(name).toLowerCase() }))
    .filter((u) => { try { return statSync(u.file).isFile(); } catch { return false; } })
    .filter((u) => TEXT.has(u.ext) || PICTURE.has(u.ext));
}

/** True when the uploads hold a picture: the call then needs the Read tool. */
export const uploadsHavePictures = (work) => uploads(work).some((u) => PICTURE.has(u.ext));

export function uploadsBlock(work) {
  const all = uploads(work);
  if (!all.length) return '';
  let left = ALL;
  const parts = all.map((u) => {
    if (PICTURE.has(u.ext)) return `### ${u.name} (picture)\nOpen ${u.file} with Read.`;
    const text = readFileSync(u.file, 'utf8');
    const take = text.slice(0, Math.max(0, Math.min(EACH, left)));
    left -= take.length;
    if (!take) return `### ${u.name}\nToo long to include here: open ${u.file} with Read.`;
    return `### ${u.name}${take.length < text.length ? ` (first ${take.length} of ${text.length} characters; the whole file: ${u.file})` : ''}\n\`\`\`${u.ext.slice(1)}\n${take}\n\`\`\``;
  });
  return `## The owner's own uploads (their reference for this video: follow their style, palette, type and motion)\n${parts.join('\n\n')}`;
}
