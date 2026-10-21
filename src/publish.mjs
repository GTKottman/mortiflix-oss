// Publishing a delivered video to your social accounts, through the service you picked in setup:
//   uploadpost  Upload-Post (https://upload-post.com), hosted, paid plans
// Started by @mutonby (Upload-Post, PR #3). Postiz was removed on 2026-10-21 after the Railway breach (README).
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

export const SERVICES = {
  uploadpost: { name: 'Upload-Post', key: 'uploadpost', platforms: ['tiktok', 'instagram', 'youtube', 'linkedin', 'x', 'facebook', 'threads', 'pinterest', 'bluesky'] },
};

// Where the brief said it will run (the social-short intake), as the accounts to post to.
const FROM_BRIEF = { 'TikTok / Reels / Shorts': ['tiktok', 'instagram', 'youtube'], LinkedIn: ['linkedin'], X: ['x'] };

// ---- the choice (setup) ----

export function publishConfig(config) {
  const p = config.publish || {};
  // A studio set up for Postiz before it was removed reads as not set up.
  return { service: SERVICES[p.service] ? p.service : 'none', profile: p.profile || null };
}

// The service (uploadpost or none) and the Upload-Post profile.
export function savePublish(root, { service, profile } = {}) {
  const cur = publishConfig(loadConfig(root));
  if (service === 'postiz') throw new UserError('Postiz was removed after the Railway breach of 2026-10-21: use Upload-Post (see the README)');
  if (service !== undefined && service !== 'none' && !SERVICES[service]) throw new UserError('publishing: uploadpost or none');
  saveConfig(root, { publish: {
    service: service ?? cur.service,
    profile: profile !== undefined ? (String(profile || '').trim() || null) : cur.profile,
  } });
  return publishConfig(loadConfig(root));
}

// ---- the plan ----

// Everything a post needs, checked before anything is sent: what you see is what goes out.
export function publishPlan(root, id, { to, profile, title, description, at, timezone, again } = {}) {
  const service = publishConfig(loadConfig(root)).service;
  if (service === 'none') throw new UserError('publishing isn\'t set up: pick Upload-Post with `mortiflix setup publish` (or in Settings › Setup)');
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

  // Upload-Post posts under one of your profiles there.
  const who = service === 'uploadpost' ? String(profile || publishConfig(loadConfig(root)).profile || '').trim() : null;
  if (service === 'uploadpost' && !who) throw new UserError('which Upload-Post profile? Pass --profile with the name your accounts are connected under (it\'s remembered)');
  const caption = String(title ?? p.title).trim();
  if (!caption) throw new UserError('a post needs a title: pass --title');
  if (timezone && !at) throw new UserError('--timezone only goes with --at');
  if (timezone) { try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new UserError(`--timezone "${timezone}" isn't a time zone (e.g. Europe/Madrid)`); } }
  if (at && Number.isNaN(Date.parse(at))) throw new UserError(`--at "${at}" isn't a date and time (e.g. 2026-10-20T18:00)`);

  const st = statSync(file);
  // The same video to the same place at the same time is the same post: a retry never posts it twice. --again is a
  // new post on purpose.
  const key = createHash('sha256').update([id, video.file, st.size, service, who || '', platforms.join(','), at || '', timezone || '', again ? now() : ''].join('\n')).digest('hex').slice(0, 32);
  return { id, service, project: p.title, file, size: st.size, platforms, profile: who, title: caption, description: description ? String(description) : null, at: at || null, timezone: timezone || null, key, from_brief: !to && Boolean(fromBrief) };
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
  const sent = await sendUploadPost(root, plan, { fetch });
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

// ---- how it went ----

// How the last post of a project is going, per platform, with the links once they're live.
export async function publishStatus(root, id, { fetch = globalThis.fetch } = {}) {
  const last = (loadProject(root, id).published || []).at(-1);
  if (!last) throw new UserError('this project hasn\'t been published');
  if (last.service === 'postiz') throw new UserError('that post went out through Postiz, which was removed after the Railway breach of 2026-10-21: check it in Postiz itself');
  return uploadPostStatus(root, last, { fetch });
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
