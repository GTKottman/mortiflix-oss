// Publishing a delivered video to your social accounts, through Upload-Post (https://upload-post.com).
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

export const PLATFORMS = ['tiktok', 'instagram', 'youtube', 'linkedin', 'x', 'facebook', 'threads', 'pinterest', 'bluesky'];

// Where the brief said it will run (the social-short intake), as the accounts to post to.
const FROM_BRIEF = { 'TikTok / Reels / Shorts': ['tiktok', 'instagram', 'youtube'], LinkedIn: ['linkedin'], X: ['x'] };

// Everything a post needs, checked before anything is sent: what you see is what goes out.
export function publishPlan(root, id, { to, profile, title, description, at, timezone } = {}) {
  const p = loadProject(root, id);
  if (p.state !== 'delivered') throw new UserError(`"${p.title}" isn't delivered yet (${p.state}): only an approved final is published`);
  const video = p.deliverables.find((f) => f.kind === 'video');
  if (!video) throw new UserError(`"${p.title}" delivered no video to publish`);
  const file = join(projectPaths(root, id).state, video.file);
  if (!existsSync(file)) throw new UserError(`the delivered video is missing from the record (${video.file})`);

  const fromBrief = FROM_BRIEF[p.intake.answers.platform];
  const platforms = to ? String(to).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : fromBrief || [];
  if (!platforms.length) throw new UserError(`where to? Pass --to with one or more of: ${PLATFORMS.join(', ')}`);
  const unknown = platforms.filter((s) => !PLATFORMS.includes(s));
  if (unknown.length) throw new UserError(`can't publish to ${unknown.join(', ')} (one or more of: ${PLATFORMS.join(', ')})`);

  const who = String(profile || loadConfig(root).publish?.profile || '').trim();
  if (!who) throw new UserError('which Upload-Post profile? Pass --profile with the name your accounts are connected under (it\'s remembered)');
  const caption = String(title ?? p.title).trim();
  if (!caption) throw new UserError('a post needs a title: pass --title');
  if (timezone && !at) throw new UserError('--timezone only goes with --at');
  if (at && Number.isNaN(Date.parse(at))) throw new UserError(`--at "${at}" isn't a date and time (e.g. 2026-10-20T18:00)`);

  const st = statSync(file);
  // The same video to the same place at the same time is the same post: a retry never posts it twice.
  const key = createHash('sha256').update([id, video.file, st.size, who, platforms.join(','), at || '', timezone || ''].join('\n')).digest('hex').slice(0, 32);
  return { id, project: p.title, file, size: st.size, platforms, profile: who, title: caption, description: description ? String(description) : null, at: at || null, timezone: timezone || null, key, from_brief: !to && Boolean(fromBrief) };
}

// Sends the plan. Returns Upload-Post's ids: `request_id` for a post that goes out now, `job_id` for a scheduled one.
export async function publish(root, plan, { fetch = globalThis.fetch } = {}) {
  const apiKey = keyValue(root, 'uploadpost');
  if (!apiKey) throw new UserError('publishing needs your Upload-Post API key: add it with `mortiflix keys set uploadpost`');
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

  const sent = { request_id: body.request_id || null, job_id: body.job_id || null, platforms: plan.platforms, profile: plan.profile, scheduled_for: plan.at, sent_at: now() };
  update(root, plan.id, (p) => { p.published = [...(p.published || []), sent]; });
  event(root, plan.id, { event: 'PUBLISHED', actor: 'you', details: `${plan.platforms.join(', ')}${plan.at ? ` at ${plan.at}${plan.timezone ? ` ${plan.timezone}` : ''}` : ''}` });
  if (loadConfig(root).publish?.profile !== plan.profile) saveConfig(root, { publish: { ...loadConfig(root).publish, profile: plan.profile } });
  return sent;
}

// How the last post of a project is going, per platform, with the links once they're live.
export async function publishStatus(root, id, { fetch = globalThis.fetch } = {}) {
  const last = (loadProject(root, id).published || []).at(-1);
  if (!last) throw new UserError('this project hasn\'t been published');
  const apiKey = keyValue(root, 'uploadpost');
  if (!apiKey) throw new UserError('checking needs your Upload-Post API key: add it with `mortiflix keys set uploadpost`');
  const q = last.job_id ? `job_id=${encodeURIComponent(last.job_id)}` : `request_id=${encodeURIComponent(last.request_id)}`;
  const res = await fetch(`${API()}/api/uploadposts/status?${q}`, { headers: { Authorization: `Apikey ${apiKey}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`Upload-Post couldn't say (${res.status}): ${body.message || body.error || 'no reason given'}`);
  return {
    ...last,
    status: body.status || 'unknown',
    message: body.message || null,
    // Each platform: completed, failed, or still on its way (queued, processing…), as Upload-Post reports it.
    results: (body.results || []).map((r) => ({ platform: r.platform, state: r.status || (r.success ? 'completed' : 'failed'), url: r.post_url || null, message: r.error_message || r.message || null })),
  };
}
