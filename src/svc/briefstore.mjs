// New Project drafts, the source tray and saved brief presets (plan 52). Drafts live in <studio>/drafts/<id>/:
// draft.json (the brief), sources.json (the tray) and sources/ (uploaded files). Brief presets: <studio>/brief-presets/.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, realpathSync, copyFileSync } from 'node:fs';
import { join, basename, extname, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { lookup as dnsLookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { BlockList, isIP } from 'node:net';
import { normalizeBrief } from './briefschema.mjs';
import { writeJson } from '../studio.mjs';

const bad = (m) => { const e = new Error(m); e.code = 'bad_request'; throw e; };
const now = () => new Date().toISOString();
export const DRAFT_ID = /^d-[a-z0-9]{6,12}$/;
const MAX_TEXT = 200_000;
const MAX_BYTES = 8 * 1024 ** 2; // a fetched page or document

const draftsDir = (root) => join(root, 'drafts');
export const draftDir = (root, id) => join(draftsDir(root), DRAFT_ID.test(String(id)) ? id : bad('That draft id is not valid.'));
export const newDraftId = () => `d-${randomBytes(4).toString('hex')}`;
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

// ---- drafts
// saved_at must strictly increase: two saves in the same millisecond would tie and "newest draft" would be a coin toss.
let lastDraftAt = '';
const draftNow = () => {
  let at = now();
  if (at <= lastDraftAt) at = new Date(Date.parse(lastDraftAt) + 1).toISOString();
  lastDraftAt = at;
  return at;
};
export function saveDraft(root, { draft, brief }) {
  const id = draft || newDraftId();
  const dir = draftDir(root, id);
  const { brief: clean, errors } = normalizeBrief(brief);
  const at = draftNow();
  writeJson(join(dir, 'draft.json'), { id, brief: clean, saved_at: at });
  return { draft: id, saved_at: at, errors };
}
export function getDraft(root, id) {
  if (!id) id = listDrafts(root)[0]?.id;
  if (!id) return null;
  const d = readJson(join(draftDir(root, id), 'draft.json'), null);
  if (!d) return null;
  return { ...d, sources: listSources(root, id) };
}
export function listDrafts(root) {
  let ids = [];
  try { ids = readdirSync(draftsDir(root)).filter((n) => DRAFT_ID.test(n)); } catch { /* none */ }
  return ids.map((id) => {
    const d = readJson(join(draftsDir(root), id, 'draft.json'), null);
    return { id, saved_at: d?.saved_at || '', idea_excerpt: String(d?.brief?.idea || '').replace(/\s+/g, ' ').slice(0, 120), sources: listSources(root, id).length };
  }).filter((d) => d.saved_at || d.sources).sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1));
}
export function deleteDraft(root, id) { rmSync(draftDir(root, id), { recursive: true, force: true }); return { deleted: true }; }

// ---- sources
const srcFile = (root, id) => join(draftDir(root, id), 'sources.json');
export const listSources = (root, id) => readJson(srcFile(root, id), []);
const saveSources = (root, id, list) => writeJson(srcFile(root, id), list);
const nextId = (list) => `s${String(Math.max(0, ...list.map((s) => Number(s.id.slice(1)) || 0)) + 1).padStart(2, '0')}`;
function patch(root, draft, id, change) {
  const list = listSources(root, draft);
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return null; // removed while it was being read
  list[i] = { ...list[i], ...change };
  saveSources(root, draft, list);
  return list[i];
}

const KINDS = { '.pdf': 'pdf', '.docx': 'docx', '.txt': 'text', '.md': 'text', '.markdown': 'text', '.rtf': 'text', '.srt': 'text', '.vtt': 'text', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.svg': 'image', '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.mkv': 'video', '.wav': 'audio', '.mp3': 'audio', '.m4a': 'audio', '.flac': 'audio', '.ogg': 'audio' };
export const kindOfFile = (name) => KINDS[extname(name).toLowerCase()] || 'other';

export function parseUrl(u) {
  let url;
  try { url = new URL(String(u || '').trim()); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol) || !url.hostname.includes('.') && url.hostname !== 'localhost') bad('That is not a web link (it must start with http:// or https://).');
  return url;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb', middot: '\u00b7', bull: '\u2022', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', times: '\u00d7', euro: '\u20ac', pound: '\u00a3', eacute: '\u00e9', egrave: '\u00e8', aacute: '\u00e1', iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa', ntilde: '\u00f1', uuml: '\u00fc', ouml: '\u00f6', auml: '\u00e4', ccedil: '\u00e7', shy: '' };
export const decodeEntities = (s) => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+[0-9]*);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
// Some sites encode their <title> twice ("&amp;mdash;"): a second pass there, so a link never shows a raw entity.
const decodeTitle = (s) => { const once = decodeEntities(s); return /&amp;/i.test(s) ? decodeEntities(once) : once; };

// Plain text out of the markup: scripts, styles and tags gone, entities decoded, blank runs collapsed.
export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = decodeEntities(html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title ? decodeTitle(title).replace(/\s+/g, ' ').trim().slice(0, 200) : '', text };
}

const run = (cmd, args, { input } = {}) => new Promise((ok, fail) => {
  const p = execFile(cmd, args, { maxBuffer: 64 * 1024 ** 2, timeout: 60_000, encoding: 'utf8' }, (e, out) => (e ? fail(e) : ok(out)));
  if (input) p.stdin.end(input);
});
export async function fileText(file, kind) {
  if (kind === 'text') return readFileSync(file, 'utf8');
  if (kind === 'pdf') {
    try { return await run('pdftotext', ['-layout', file, '-']); } catch (e) { throw new Error(e.code === 'ENOENT' ? 'Reading PDFs needs pdftotext on this computer.' : 'That PDF could not be read.'); }
  }
  if (kind === 'docx') {
    try { return htmlToText((await run('unzip', ['-p', file, 'word/document.xml']).then((x) => x.replace(/<\/w:p>/g, '</p>'))) ).text; } catch { throw new Error('That Word file could not be read.'); }
  }
  return '';
}

function textFile(root, draft, id) { return join(draftDir(root, draft), 'text', `${id}.txt`); }
export function sourceText(root, draft, id) { try { return readFileSync(textFile(root, draft, id), 'utf8'); } catch { return ''; } }
function putText(root, draft, id, text) { const f = textFile(root, draft, id); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text.slice(0, MAX_TEXT)); }

// SSRF guard (OWASP SSRF Prevention Cheat Sheet): a link is read only when every address its host resolves to is a
// public one (no loopback, private, link-local, tailnet/CGNAT, cloud metadata, multicast), and redirects are followed
// by hand, at most MAX_REDIRECTS, each hop checked the same way.
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(net, bits, 'ipv6');
// An IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) address is judged by the IPv4 address inside it. Not as
// BlockList subnets: Node's BlockList matches an IPv4 address against a ::ffff:0:0/96 rule, so that rule blocked every
// public IPv4 site (found 2026-11-03: every brief link failed with "points inside this computer").
function embeddedV4(address) {
  const a = address.toLowerCase();
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(a);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16), lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}
const isPrivate = (address) => {
  const v = isIP(address);
  if (v === 4) return PRIVATE.check(address, 'ipv4');
  if (v !== 6) return true;
  const inner = embeddedV4(address);
  return inner ? isPrivate(inner) : PRIVATE.check(address, 'ipv6');
};
const MAX_REDIRECTS = 5;
const INSIDE = 'That link points inside this computer or its network; the studio only reads public pages.';

async function checkPublic(url, lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }); } catch (e) { throw new Error(`Could not reach that link (${String(e.code || e.message).slice(0, 80)}).`); }
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error(INSIDE);
}

// The address checked is the address connected to: a host name is checked again inside the socket's own lookup
// (nodejs.org/api/net.html socket.connect `lookup`: "Custom lookup function. Default: dns.lookup()"), so a DNS answer
// that changes between checkPublic and the connection (DNS rebinding, OWASP SSRF cheat sheet) cannot reach inside.
// With `all: true` (autoSelectFamily) dns.lookup answers (err, [{ address, family }]); else (err, address, family).
function publicLookup(host, options, cb) {
  dnsLookupCb(host, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!list.length || list.some((a) => isPrivate(a.address))) return cb(Object.assign(new Error(INSIDE), { code: 'EMFXINSIDE' }));
    cb(null, address, family);
  });
}

// A GET with publicLookup, answering the small part of fetch's Response fetchPage uses; stops reading past MAX_BYTES.
function pinnedFetch(href, { signal, headers } = {}) {
  return new Promise((resolveP, reject) => {
    const u = new URL(href);
    // node:http does not decode bodies: ask for the codings zlib reads and decode them (RFC 9110 §8.4 Content-Encoding;
    // nodejs.org/api/zlib.html "Compressing HTTP requests and responses"); MAX_BYTES counts the decoded page
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'GET', headers: { ...headers, 'accept-encoding': 'gzip, deflate, br' }, signal, lookup: publicLookup }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
      const dec = enc === 'gzip' || enc === 'x-gzip' ? createGunzip() : enc === 'deflate' ? createInflate() : enc === 'br' ? createBrotliDecompress() : null;
      const body = dec ? res.pipe(dec) : res;
      if (dec) res.on('error', (e) => dec.destroy(e));
      const chunks = []; let size = 0;
      body.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { res.destroy(); body.destroy(); reject(new Error('That page is too big to read (over 8 MB).')); } else chunks.push(c); });
      body.on('error', reject);
      body.on('end', () => {
        const body = Buffer.concat(chunks);
        const status = res.statusCode || 0;
        resolveP({ status, ok: status >= 200 && status < 300, headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } }, arrayBuffer: async () => body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchPage(url, fetch, lookup) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    let at = url;
    for (let hop = 0; ; hop++) {
      await checkPublic(at, lookup);
      const r = await fetch(at.href, { signal: ac.signal, redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; MortiflixBrief/1)', accept: 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5' } });
      const loc = r.status >= 300 && r.status < 400 ? r.headers?.get?.('location') : null;
      if (loc) {
        if (hop >= MAX_REDIRECTS) throw new Error('The page sent too many redirects.');
        let next;
        try { next = new URL(loc, at); } catch { next = null; }
        if (!next || !/^https?:$/.test(next.protocol)) throw new Error('The page redirected to something that is not a web link.');
        at = next;
        continue;
      }
      if (!r.ok) throw new Error(`The page answered ${r.status}.`);
      const type = String(r.headers?.get?.('content-type') || '');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error('That page is too big to read (over 8 MB).');
      return { type, buf };
    }
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The page took too long to answer.' : /^The page|^That page|^That link|^Could not reach/.test(e.message) ? e.message : `Could not reach that link (${String(e.cause?.code || e.message).slice(0, 80)}).`);
  } finally { clearTimeout(timer); }
}

// Add one source; returns the row at once. A URL is read in the background (onChange tells the screen).
export function addSource(root, { draft, url, path, name }, { fetch = pinnedFetch, lookup = dnsLookup, onChange = () => {} } = {}) {
  if (!url && !path) bad('sources.add needs a url or a path');
  const parsed = url ? parseUrl(url) : null;
  const id = draft || newDraftId();
  const dir = draftDir(root, id);
  mkdirSync(dir, { recursive: true });
  const list = listSources(root, id);
  const sid = nextId(list);
  let row;
  if (parsed) {
    if (list.some((s) => s.url === parsed.href)) bad('That link is already in the tray.');
    row = { id: sid, kind: 'url', label: parsed.hostname + (parsed.pathname.length > 1 ? parsed.pathname : ''), url: parsed.href, status: 'fetching', status_text: 'Reading the page…', chars: 0, added_at: now() };
  } else {
    const sdir = join(dir, 'sources');
    let real;
    try { real = realpathSync(resolve(String(path))); } catch { bad('That file is not there.'); }
    const base = existsSync(sdir) ? realpathSync(sdir) : null;
    if (!base || !real.startsWith(base + sep) || !statSync(real).isFile()) bad('Files must be uploaded to this draft first.');
    const fname = String(name || basename(real).replace(/^\d+-/, ''));
    row = { id: sid, kind: kindOfFile(fname), label: fname.slice(0, 200), name: fname.slice(0, 200), file: real, bytes: statSync(real).size, status: 'fetching', status_text: 'Reading the file…', chars: 0, added_at: now() };
    if (['image', 'video', 'audio', 'other'].includes(row.kind)) { row.status = 'stored'; row.status_text = row.kind === 'other' ? (/\.(html?|css|js|jsx|ts|tsx|json)$/i.test(row.label || '') ? 'Stored: the look, stills and motion read it' : 'Stored as it is (the studio cannot read this kind of file)') : 'Stored as it is'; }
  }
  saveSources(root, id, [...list, row]);
  if (row.status === 'fetching') {
    (async () => {
      let change;
      try {
        let text = '', title = '';
        if (parsed) {
          const { type, buf } = await fetchPage(parsed, fetch, lookup);
          if (/pdf/i.test(type) || /\.pdf$/i.test(parsed.pathname) || buf.subarray(0, 5).toString() === '%PDF-') {
            const tmp = join(tmpdir(), `brief-${randomBytes(4).toString('hex')}.pdf`);
            writeFileSync(tmp, buf, { mode: 0o600 }); // the shared temp folder: readable by this user only
            try { text = await fileText(tmp, 'pdf'); } finally { rmSync(tmp, { force: true }); }
            row.kind = 'pdf';
          } else if (/html|xml/i.test(type) || !type) ({ text, title } = htmlToText(buf.toString('utf8')));
          else if (/^text\//i.test(type)) text = buf.toString('utf8');
          else if (/^(image|video|audio)\//i.test(type)) { change = { status: 'stored', status_text: 'A media link, kept as a link', kind: type.split('/')[0] }; }
          else throw new Error('That link is not a page or a document the studio can read.');
        } else text = await fileText(row.file, row.kind);
        if (!change) {
          text = text.replace(/\r/g, '').trim();
          if (!text) throw new Error(parsed ? 'No readable text on that page (it may need a login or load by script).' : 'No readable text in that file.');
          putText(root, id, sid, text);
          change = { status: 'ready', status_text: `Read ${Math.min(text.length, MAX_TEXT).toLocaleString('en-US')} characters`, chars: Math.min(text.length, MAX_TEXT), ...(title ? { label: title } : {}), kind: row.kind };
        }
      } catch (e) { change = { status: 'failed', status_text: 'Could not read it', error: String(e.message).slice(0, 300) }; }
      const done = patch(root, id, sid, change);
      if (done) onChange({ draft: id, source: done });
    })();
  }
  return { draft: id, source: row };
}

export function removeSource(root, draft, id) {
  const list = listSources(root, draft);
  const row = list.find((s) => s.id === id);
  if (!row) bad('That source is not in the tray.');
  if (row.file) rmSync(row.file, { force: true });
  rmSync(textFile(root, draft, id), { force: true });
  saveSources(root, draft, list.filter((s) => s.id !== id));
  return { removed: id };
}

// A draft's sources move into the new project: files and extracted text under design/sources/.
export function moveSourcesToProject(root, draft, projectWork) {
  const out = [];
  const dest = join(projectWork, 'design', 'sources');
  const list = listSources(root, draft);
  if (list.length) mkdirSync(dest, { recursive: true });
  for (const s of list) {
    const row = { id: s.id, kind: s.kind, label: s.label, status: s.status, chars: s.chars || 0, ...(s.url ? { url: s.url } : {}), ...(s.error ? { error: s.error } : {}) };
    if (s.file && existsSync(s.file)) { const to = join(dest, `${s.id}-${basename(s.file).replace(/^\d+-/, '')}`); copyFileSync(s.file, to); row.file = to; }
    const text = sourceText(root, draft, s.id);
    if (text) { const to = join(dest, `${s.id}.txt`); writeFileSync(to, text); row.text_file = to; row.excerpt = text.replace(/\s+/g, ' ').slice(0, 1200); }
    out.push(row);
  }
  return out;
}

// ---- brief presets
const presetDir = (root) => join(root, 'brief-presets');
const slugOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
export const customizedCount = (b) => ['story', 'visual', 'voice', 'delivery', 'workflow'].reduce((n, s) => n + Object.keys(b?.[s] || {}).length, 0);
export function saveBriefPreset(root, { name, brief }) {
  const nm = String(name || '').trim();
  if (!nm) bad('Give the preset a name.');
  const slug = slugOf(nm) || bad('Give the preset a name with letters in it.');
  const { brief: clean, errors } = normalizeBrief(brief);
  if (errors.length) bad(errors[0].message);
  delete clean.idea; delete clean.sources; delete clean.title; // a preset is the production choices, not one video's idea
  const at = now();
  writeJson(join(presetDir(root), `${slug}.json`), { slug, name: nm.slice(0, 80), saved_at: at, brief: clean });
  return { slug, name: nm.slice(0, 80), saved_at: at };
}
export function listBriefPresets(root) {
  let files = [];
  try { files = readdirSync(presetDir(root)).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  return files.map((f) => readJson(join(presetDir(root), f), null)).filter(Boolean).map((p) => ({ ...p, customized: customizedCount(p.brief) })).sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1));
}
export function deleteBriefPreset(root, slug) {
  const f = join(presetDir(root), `${slugOf(slug)}.json`);
  if (!existsSync(f)) bad('That preset is not there.');
  rmSync(f);
  return { deleted: true };
}
