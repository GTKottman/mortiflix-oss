// The review rules of the Voice & music screen, as plain functions: which lines need a look, why, and in what order.
import { clock } from '../../lib/time';
import { plural } from '../../lib/words';
import type { CueState, LineCheck, MusicCue, TakeSet, TakeVersion, VoiceLine } from './types';

/** A time on this screen: whole seconds, the part of a second dropped (74.6 -> "1:14"). */
export const voiceClock = (seconds: number): string => clock(seconds, { truncate: true });

const MAKING = ['generating', 'running', 'making', 'pending'];

/** The words heard differ from the script. */
export function isBad(line: VoiceLine, check: LineCheck | undefined): boolean {
  if (check) return check.ok === false;
  return Boolean(line.checked) && line.words_ok === false;
}

export const isMaking = (line: VoiceLine, sentForReread: boolean): boolean =>
  sentForReread || MAKING.includes(line.state);

/** Not approved yet, or the words differ. */
export const needsYou = (line: VoiceLine, check: LineCheck | undefined): boolean =>
  line.state !== 'approved' || isBad(line, check);

/** How many words differ from the script (0 when the check has no list). */
export const differingWords = (check: LineCheck | undefined): number =>
  check ? check.missing.length + check.extra.length : 0;

/** A piece the studio tried to make and could not (the service's node state "needs you"). */
export const LINE_FAILED = 'Could not be made';

export function reasonOf(line: VoiceLine, check: LineCheck | undefined, making: boolean): string {
  if (isBad(line, check)) {
    const n = differingWords(check);
    return n
      ? `${plural(n, 'word')} ${n === 1 ? 'differs' : 'differ'} from the script`
      : 'Words differ from the script';
  }
  if (line.state === 'needs you') return LINE_FAILED;
  return making ? 'Being made' : 'Not approved yet';
}

export const CUE_REASON: Record<CueState, string> = {
  ok: '',
  made: 'Made, not approved yet',
  stale: 'The words changed, so it needs a look',
  planned: 'Not made yet',
};

export const cueNumber = (id: string): string => String(Number(id.replace(/\D/g, '')) || id);
export const cueName = (id: string): string => `Music ${cueNumber(id)}`;

/** "Scene 2 · line 3" */
export function lineName(lines: readonly VoiceLine[], id: string): string {
  const line = lines.find((l) => l.node === id);
  if (!line) return 'Line';
  const k = lines.filter((l) => l.beat === line.beat).findIndex((l) => l.node === id) + 1;
  return `Scene ${line.beat_no} · line ${k}`;
}

export interface Scene {
  beat: string;
  no: number;
  chip?: string;
  start: number;
}

/** The scenes in order, each with the second its first line starts. */
export function scenesOf(lines: readonly VoiceLine[]): Scene[] {
  const out: Scene[] = [];
  for (const line of lines) {
    if (!out.some((s) => s.beat === line.beat)) {
      out.push({ beat: line.beat, no: line.beat_no, chip: line.colour?.chip, start: line.start_sec });
    }
  }
  return out;
}

/** The pause after a line: the check's number, else the real gap to the next line. */
export function pauseAfter(
  lines: readonly VoiceLine[],
  index: number,
  check: LineCheck | undefined,
): number | null {
  if (check && check.gap_after != null) return check.gap_after;
  const line = lines[index];
  const next = lines[index + 1];
  if (!line || !next) return null;
  return Math.max(0, Math.round((next.start_sec - (line.start_sec + line.dur_sec)) * 100) / 100);
}

export interface Issue {
  kind: 'line' | 'cue';
  id: string;
  at: number;
  name: string;
  why: string;
}

export function issuesOf(
  lines: readonly VoiceLine[],
  checkOf: (id: string) => LineCheck | undefined,
  isMakingLine: (line: VoiceLine) => boolean,
  cues: readonly MusicCue[],
): Issue[] {
  const out: Issue[] = [];
  for (const line of lines) {
    const check = checkOf(line.node);
    if (needsYou(line, check)) {
      out.push({
        kind: 'line',
        id: line.node,
        at: line.start_sec,
        name: lineName(lines, line.node),
        why: reasonOf(line, check, isMakingLine(line)),
      });
    }
  }
  for (const cue of cues) {
    if (cue.state !== 'ok') {
      out.push({
        kind: 'cue',
        id: cue.id,
        at: cue.from_sec,
        name: cueName(cue.id),
        why: CUE_REASON[cue.state] || 'To check',
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The issue after (1) or before (-1) the selected one, wrapping round; with nothing selected, the first or last. */
export function stepIssue(
  issues: readonly Issue[],
  selectedId: string | null,
  direction: 1 | -1,
): Issue | null {
  if (!issues.length) return null;
  let at = issues.findIndex((issue) => issue.id === selectedId);
  if (at < 0) at = direction > 0 ? -1 : 0;
  return issues[(at + direction + issues.length) % issues.length] ?? null;
}

/** "1:14" style start of an issue, for the list. */
export const issueTime = (issue: Issue): string => voiceClock(issue.at);

/** The reads that have a file, and the index of the one in use (the first when none says so). */
export function usableTakes(takes: TakeSet | undefined): { versions: TakeVersion[]; inUse: number } {
  const versions = (takes?.versions ?? []).filter((v) => v.path !== null);
  return {
    versions,
    inUse: Math.max(
      0,
      versions.findIndex((v) => v.v === takes?.plays),
    ),
  };
}

export const credits = (n: number): string => Math.round(n).toLocaleString('en');

/** The words on the review bar (top right of the head). */
export const REVIEW_BAR = {
  count: (n: number): string => `${n} to review`,
  none: '✓ All reviewed',
  approveAll: (n: number): string => `✓ Approve all ${n}`,
  next: 'Next issue ›',
  previous: '‹ Previous issue',
};

/** What to tell when ElevenLabs stops paid work for billing (401, 402 or 429). */
export const billingStop = (reason: string, code: string): string =>
  `ElevenLabs stopped: ${reason} (${code}). Nothing else was sent.`;

/** The line on the audio overview once nothing is left to review. */
export const ALL_APPROVED = '✓ Every line and cue is approved. You can go on to Look.';

/** Button labels the owner presses on this screen. */
export const VOICE_ACTIONS = {
  approve: '✓ Approve',
  approved: '✓ Approved',
  reread: 'Queue a re-read',
  makeQueue: 'Make the queue',
  settings: 'Open Settings',
};
