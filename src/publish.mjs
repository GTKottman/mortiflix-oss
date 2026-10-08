// Publishing a delivered video to your social accounts, through the service you picked in setup:
//   uploadpost  Upload-Post (https://upload-post.com), hosted, paid plans
//   postiz      your own Postiz (https://postiz.com), free and open source (AGPL-3.0), self-hosted
// Started by @mutonby (Upload-Post, PR #3); Postiz added alongside it.
//
// Only you publish. It's reachable from the CLI, never from `mfx`, so a session can't post anything; and only a
// delivered project's approved video goes out, never a version still in review. Nothing here runs on its own.
import { createHash } from 'node:crypto';
import { existsSync, openAsBlob, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig, UserError } from './studio.mjs';
import { loadProject, projectPaths, update, event, now } from './projects.mjs';
import { keyValue } from './keys.mjs';

// UPLOAD_POST_API moves it (e.g. to a staging server); the key is sent there.
export const API = () => process.env.UPLOAD_POST_API || 'https://api.upload-post.com';

// The official Postiz Docker image answers its API here; Postiz Cloud is https://api.postiz.com.
export const POSTIZ_DEFAULT = 'http://localhost:4007/api';

export const SERVICES = {
  uploadpost: { name: 'Upload-Post', key: 'uploadpost', platforms: ['tiktok', 'instagram', 'youtube', 'linkedin', 'x', 'facebook', 'threads', 'pinterest', 'bluesky'] },
  // Pinterest is left out: Postiz needs a board for it, which the studio has no way to know.
  postiz: { name: 'Postiz', key: 'postiz', platforms: ['tiktok', 'instagram', 'youtube', 'linkedin', 'x', 'facebook', 'threads', 'bluesky', 'mastodon'] },
};

// The platforms by every name they're shown under, and which Postiz channel types post to each.
const POSTIZ_TYPES = { instagram: ['instagram', 'instagram-standalone'], linkedin: ['linkedin', 'linkedin-page'] };

// Where the brief said it will run (the social-short intake), as the accounts to post to.
const FROM_BRIEF = { 'TikTok / Reels / Shorts': ['tiktok', 'instagram', 'youtube'], LinkedIn: ['linkedin'], X: ['x'] };

// ---- the choice (setup) ----

export function publishConfig(config) {
  const p = config.publish || {};
  return { service: SERVICES[p.service] ? p.service : 'none', profile: p.profile || null, postiz: { url: p.postiz?.url || POSTIZ_DEFAULT } };
}

// The service (uploadpost, postiz or none), the Upload-Post profile, and where your Postiz is.
export function savePublish(root, { service, profile, url } = {}) {
  const cur = publishConfig(loadConfig(root));
  if (service !== undefined && service !== 'none' && !SERVICES[service]) throw new UserError('publishing: uploadpost, postiz or none');
  let postizUrl = cur.postiz.url;
  if (url !== undefined && url !== null && String(url).trim()) {
    let u;
    try { u = new URL(String(url).trim()); } catch { throw new UserError(`"${url}" isn't a web address (e.g. ${POSTIZ_DEFAULT})`); }
    if (!/^https?:$/.test(u.protocol)) throw new UserError('your Postiz address starts with http:// or https://');
    if (u.username || u.password) throw new UserError('no login in the address: Postiz takes its API key instead');
    postizUrl = u.href.replace(/\/+$/, '');
  }
  saveConfig(root, { publish: {
    service: service ?? cur.service,
    profile: profile !== undefined ? (String(profile || '').trim() || null) : cur.profile,
    postiz: { url: postizUrl },
  } });
  return publishConfig(loadConfig(root));
}

const postizBase = (root) => `${publishConfig(loadConfig(root)).postiz.url}/public/v1`;

// ---- the plan ----

// Everything a post needs, checked before anything is sent: what you see is what goes out.
export function publishPlan(root, id, { to, profile, title, description, at, timezone, again } = {}) {
  const service = publishConfig(loadConfig(root)).service;
  if (service === 'none') throw new UserError('publishing isn\'t set up: pick Upload-Post or your own Postiz with `mortiflix setup publish` (or in Settings › Setup)');
  const svc = SERVICES[service];
  const p = loadProject(root, id);
  if (p.state !== 'delivered') throw new UserError(`"${p.title}" isn't delivered yet (${p.state}): only an approved final is published`);
  const video = p.deliverables.find((f) => f.kind === 'video');
  if (!video) throw new UserError(`"${p.title}" delivered no video to publish`);
  const file = join(projectPaths(root, id).state, video.file);
  if (!existsSync(file)) throw new UserError(`the delivered video is missing from the record (${video.file})`);

  const fromBrief = FROM_BRIEF[p.intake.answers.platform];
  const platforms = to ? String(to).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : fromBrief || [];
  if (!platforms.length) throw new UserError(`where to? Pass --to with one or more of: ${svc.platforms.join(', ')}`);
  const unknown = platforms.filter((s) => !svc.platforms.includes(s));
  if (unknown.length) throw new UserError(`can't publish to ${unknown.join(', ')} through ${svc.name} (one or more of: ${svc.platforms.join(', ')})`);

  // Upload-Post posts under one of your profiles there; Postiz posts to the channels connected in it.
  const who = service === 'uploadpost' ? String(profile || publishConfig(loadConfig(root)).profile || '').trim() : null;
  if (service === 'uploadpost' && !who) throw new UserError('which Upload-Post profile? Pass --profile with the name your accounts are connected under (it\'s remembered)');
  const caption = String(title ?? p.title).trim();
  if (!caption) throw new UserError('a post needs a title: pass --title');
  if (service === 'postiz' && platforms.includes('youtube') && caption.length < 2) throw new UserError('YouTube needs a title of at least 2 characters: pass --title');
  if (timezone && !at) throw new UserError('--timezone only goes with --at');
  if (timezone) { try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new UserError(`--timezone "${timezone}" isn't a time zone (e.g. Europe/Madrid)`); } }
  if (at && Number.isNaN(Date.parse(at))) throw new UserError(`--at "${at}" isn't a date and time (e.g. 2026-10-20T18:00)`);

  const st = statSync(file);
  // The same video to the same place at the same time is the same post: a retry never posts it twice. --again is a
  // new post on purpose.
  const key = createHash('sha256').update([id, video.file, st.size, service, who || '', platforms.join(','), at || '', timezone || '', again ? now() : ''].join('\n')).digest('hex').slice(0, 32);
  return { id, service, project: p.title, file, size: st.size, platforms, profile: who, title: caption, description: description ? String(description) : null, at: at || null, timezone: timezone || null, key, from_brief: !to && Boolean(fromBrief) };
}

// A time without an offset is read in `timezone` (UTC without one), the same way Upload-Post reads it.
export function utcDate(at, timezone) {
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(at)) return new Date(at).toISOString();
  const asUtc = new Date(`${at}${/T\d\d:\d\d/.test(at) ? '' : 'T00:00'}Z`);
  if (!timezone) return asUtc.toISOString();
  const offset = (t) => {
    const g = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, g.second) - t;
  };
  const guess = asUtc.getTime() - offset(asUtc.getTime());
  return new Date(asUtc.getTime() - offset(guess)).toISOString();
}

// Postiz: the connected channels each platform goes to, so the plan can show them before anything is sent.
export async function postizChannels(root, plan, { fetch = globalThis.fetch } = {}) {
  const apiKey = needKey(root, 'postiz');
  let res;
  try { res = await fetch(`${postizBase(root)}/integrations`, { headers: { Authorization: apiKey } }); }
  catch (e) { throw new UserError(`couldn't reach your Postiz at ${publishConfig(loadConfig(root)).postiz.url} (${e.message}): is it running?`); }
  if (res.status === 401 || res.status === 403) throw new UserError('your Postiz refused the API key (check it with `mortiflix keys`)');
  if (!res.ok) throw new UserError(`your Postiz couldn't list its channels (${res.status})`);
  const all = [].concat(await res.json().catch(() => [])).filter((c) => c && !c.disabled);
  const channels = [];
  const missing = [];
  for (const platform of plan.platforms) {
    const types = POSTIZ_TYPES[platform] || [platform];
    const found = all.filter((c) => types.includes(c.identifier));
    if (!found.length) missing.push(platform);
    for (const c of found) channels.push({ id: c.id, platform, type: c.identifier, name: c.name || c.profile || c.id });
  }
  if (missing.length) throw new UserError(`no ${missing.join(', ')} channel connected in your Postiz: connect ${missing.length > 1 ? 'them' : 'it'} there, or leave ${missing.length > 1 ? 'them' : 'it'} out with --to`);
  return { ...plan, channels };
}

// ---- sending ----

function needKey(root, id) {
  const apiKey = keyValue(root, id);
  if (!apiKey) throw new UserError(`publishing needs your ${SERVICES[id].name} API key: add it with \`mortiflix keys set ${id}\``);
  return apiKey;
}

// Sends the plan and records it. Returns the ids the service gave back.
export async function publish(root, plan, { fetch = globalThis.fetch } = {}) {
  const p = loadProject(root, plan.id);
  if ((p.published || []).some((x) => x.key === plan.key)) throw new UserError('this exact post was already sent (`--status` shows how it went). Add --again to post it once more');
  const sent = plan.service === 'postiz' ? await sendPostiz(root, plan, { fetch }) : await sendUploadPost(root, plan, { fetch });
  const record = { service: plan.service, key: plan.key, platforms: plan.platforms, profile: plan.profile, scheduled_for: plan.at, timezone: plan.timezone, sent_at: now(), ...sent };
  update(root, plan.id, (x) => { x.published = [...(x.published || []), record]; });
  event(root, plan.id, { event: 'PUBLISHED', actor: 'you', details: `${plan.platforms.join(', ')} via ${SERVICES[plan.service].name}${plan.at ? ` at ${plan.at}${plan.timezone ? ` ${plan.timezone}` : ''}` : ''}` });
  if (plan.profile && publishConfig(loadConfig(root)).profile !== plan.profile) savePublish(root, { profile: plan.profile });
  return record;
}

// Upload-Post: one form with the video. `request_id` for a post that goes out now, `job_id` for a scheduled one.
async function sendUploadPost(root, plan, { fetch }) {
  const apiKey = needKey(root, 'uploadpost');
  const form = new FormData();
  form.append('user', plan.profile);
  for (const s of plan.platforms) form.append('platform[]', s);
  form.append('title', plan.title);
  if (plan.description) form.append('description', plan.description);
  if (plan.at) form.append('scheduled_date', plan.at);
  if (plan.timezone) form.append('timezone', plan.timezone);
  form.append('async_upload', 'true');
  form.append('video', await openAsBlob(plan.file, { type: 'video/mp4' }), `${plan.id}.mp4`);

  let res;
  try {
    res = await fetch(`${API()}/api/upload`, { method: 'POST', body: form, headers: { Authorization: `Apikey ${apiKey}`, 'Idempotency-Key': plan.key } });
  } catch (e) {
    throw new UserError(`couldn't reach Upload-Post (${e.message}). Run it again: the same post is never sent twice`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new UserError('Upload-Post refused the API key (check it with `mortiflix keys`)');
  if (!res.ok) throw new UserError(`Upload-Post didn't take it (${res.status}): ${body.message || body.error || 'no reason given'}`);
  return { request_id: body.request_id || null, job_id: body.job_id || null };
}

// Postiz: upload the video, then one post per channel in a single request (its rate limit counts requests).
async function sendPostiz(root, plan, { fetch }) {
  const apiKey = needKey(root, 'postiz');
  const ready = plan.channels ? plan : await postizChannels(root, plan, { fetch });
  const base = postizBase(root);
  const where = publishConfig(loadConfig(root)).postiz.url;

  const form = new FormData();
  form.append('file', await openAsBlob(plan.file, { type: 'video/mp4' }), `${plan.id}.mp4`);
  let res;
  try { res = await fetch(`${base}/upload`, { method: 'POST', body: form, headers: { Authorization: apiKey } }); }
  catch (e) { throw new UserError(`couldn't reach your Postiz at ${where} (${e.message}): nothing was posted`); }
  const media = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new UserError('your Postiz refused the API key (check it with `mortiflix keys`)');
  if (!res.ok || !media.id || !media.path) throw new UserError(`your Postiz didn't take the video (${res.status}): ${media.message || media.error || 'no reason given'}. Nothing was posted`);

  const text = [plan.title, plan.description].filter(Boolean).join('\n\n');
  const posts = ready.channels.map((c) => ({
    integration: { id: c.id },
    value: [{ content: c.type === 'youtube' ? plan.description || plan.title : text, image: [{ id: media.id, path: media.path }] }],
    settings: postizSettings(c.type, plan),
  }));
  const body = { type: plan.at ? 'schedule' : 'now', date: plan.at ? utcDate(plan.at, plan.timezone) : new Date().toISOString(), shortLink: false, tags: [], posts };
  try {
    res = await fetch(`${base}/posts`, { method: 'POST', body: JSON.stringify(body), headers: { Authorization: apiKey, 'Content-Type': 'application/json' } });
  } catch (e) {
    // Postiz has no idempotency key: if the request got there, the post exists. Look before sending it again.
    throw new UserError(`lost your Postiz at ${where} while posting (${e.message}). Check its calendar before running this again: it may have gone through`);
  }
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new UserError(`your Postiz didn't take the post (${res.status}): ${out?.message || out?.error || 'no reason given'}`);
  const byId = Object.fromEntries(ready.channels.map((c) => [c.id, c]));
  return {
    date: body.date,
    posts: (Array.isArray(out) ? out : []).map((x) => ({ id: x.postId, channel: x.integration, platform: byId[x.integration]?.platform || null, name: byId[x.integration]?.name || null })),
  };
}

// What each kind of channel needs besides the text: public, with the platform's own defaults for everything else.
export function postizSettings(type, plan) {
  switch (type) {
    case 'tiktok': return { __type: 'tiktok', title: plan.title.slice(0, 90), privacy_level: 'PUBLIC_TO_EVERYONE', duet: false, stitch: false, comment: true, autoAddMusic: 'no', brand_content_toggle: false, brand_organic_toggle: false, content_posting_method: 'DIRECT_POST' };
    case 'youtube': return { __type: 'youtube', title: plan.title.slice(0, 100), type: 'public' };
    case 'instagram': case 'instagram-standalone': return { __type: type, post_type: 'post' };
    case 'x': return { __type: 'x', who_can_reply_post: 'everyone' };
    default: return { __type: type };
  }
}

// ---- how it went ----

// How the last post of a project is going, per platform, with the links once they're live.
export async function publishStatus(root, id, { fetch = globalThis.fetch } = {}) {
  const last = (loadProject(root, id).published || []).at(-1);
  if (!last) throw new UserError('this project hasn\'t been published');
  return (last.service || 'uploadpost') === 'postiz' ? postizStatus(root, last, { fetch }) : uploadPostStatus(root, last, { fetch });
}

async function uploadPostStatus(root, last, { fetch }) {
  const apiKey = needKey(root, 'uploadpost');
  const q = last.job_id ? `job_id=${encodeURIComponent(last.job_id)}` : `request_id=${encodeURIComponent(last.request_id)}`;
  const res = await fetch(`${API()}/api/uploadposts/status?${q}`, { headers: { Authorization: `Apikey ${apiKey}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`Upload-Post couldn't say (${res.status}): ${body.message || body.error || 'no reason given'}`);
  return {
    ...last,
    ref: last.job_id ? `job ${last.job_id}` : `request ${last.request_id}`,
    status: body.status || 'unknown',
    message: body.message || null,
    // Each platform: completed, failed, or still on its way (queued, processing…), as Upload-Post reports it.
    results: (body.results || []).map((r) => ({ platform: r.platform, state: r.status || (r.success ? 'completed' : 'failed'), url: r.post_url || null, message: r.error_message || r.message || null })),
  };
}

const POSTIZ_STATES = { QUEUE: 'queued', PUBLISHED: 'completed', ERROR: 'failed', DRAFT: 'draft' };

async function postizStatus(root, last, { fetch }) {
  const apiKey = needKey(root, 'postiz');
  // Postiz lists posts by date: a window around when it was sent and when it was due.
  const times = [Date.parse(last.sent_at), Date.parse(last.date || last.sent_at)];
  const day = 24 * 3600 * 1000;
  const q = `startDate=${encodeURIComponent(new Date(Math.min(...times) - day).toISOString())}&endDate=${encodeURIComponent(new Date(Math.max(...times) + 2 * day).toISOString())}`;
  let res;
  try { res = await fetch(`${postizBase(root)}/posts?${q}`, { headers: { Authorization: apiKey } }); }
  catch (e) { throw new UserError(`couldn't reach your Postiz (${e.message}): is it running?`); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`your Postiz couldn't say (${res.status}): ${body.message || body.error || 'no reason given'}`);
  const found = Object.fromEntries((body.posts || []).map((x) => [x.id, x]));
  const results = (last.posts || []).map((x) => {
    const post = found[x.id];
    if (!post) return { platform: x.platform, state: 'gone', url: null, message: 'not in your Postiz any more (deleted there?)' };
    return { platform: x.platform || post.integration?.providerIdentifier, state: POSTIZ_STATES[post.state] || String(post.state || 'unknown').toLowerCase(), url: post.releaseURL || null, message: post.error || null };
  });
  const states = new Set(results.map((r) => r.state));
  const status = states.has('queued') ? 'queued' : states.has('failed') || states.has('gone') ? (states.has('completed') ? 'partly done' : 'failed') : results.length ? 'completed' : 'unknown';
  return { ...last, ref: `Postiz, ${results.length} post${results.length === 1 ? '' : 's'}`, status, message: null, results };
}
