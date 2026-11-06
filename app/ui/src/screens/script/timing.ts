import { clock } from '../../lib/time';
import type { Beat, Drafts, VoiceLine } from './types';

/** Words per minute the service writes the script to. */
export const WORDS_PER_MINUTE = 150;
/** A scene this much longer than planned is flagged. */
const OVER_SCENE = 1.2;
/** The whole script this far off the chosen length is flagged. */
const OFF_SCRIPT = 0.1;

export const wordsOf = (text: string): number => (text.match(/\S+/g) ?? []).length;
/** 59.6 reads "1:00", not "60 s". */
export const secondsLabel = (seconds: number): string =>
  Math.round(seconds) < 60 ? `${Math.round(seconds)} s` : clock(seconds);

export const isBusy = (beat: Beat): boolean => beat.state === 'generating';
export const isApproved = (beat: Beat): boolean => beat.state === 'approved';
/** Cut by the owner: not in the video, so it has no OK, Edit or Fix. */
export const isCut = (beat: Beat): boolean => beat.state === 'cut';
/** Waits for the owner's OK: not approved, not being made, not cut. */
export const isWaiting = (beat: Beat): boolean => !isApproved(beat) && !isBusy(beat) && !isCut(beat);
export const isDrafted = (beat: Beat, drafts: Drafts): boolean => beat.lines.some((l) => l.id in drafts);
/** Needs the owner: waits for an OK, or has unsaved words (an approved scene too). */
const needsOwner = (beat: Beat, drafts: Drafts): boolean =>
  isWaiting(beat) || (isApproved(beat) && isDrafted(beat, drafts));

export const wordsNow = (id: string, saved: string, drafts: Drafts): string => drafts[id] ?? saved;

export interface BeatTiming {
  start: number;
  dur: number;
  /** Counted from the words, not from a recorded voice. */
  est: boolean;
  words: number;
}

/**
 * The voice's own length when the scene is voiced and its words unchanged, else words at the narrator's pace
 * (labelled an estimate).
 * A scene starts at the voice's own time only while every scene before it is voiced too; after an estimate the
 * voice track's times no longer hold, so it starts where the scene before it ends.
 */
export function timingsFor(
  beats: readonly Beat[],
  voiceBy: Readonly<Record<string, VoiceLine>>,
  drafts: Drafts,
  /** The narrator's measured pace from script.get (words_per_minute); 150 when the service does not say. */
  wordsPerMinute: number = WORDS_PER_MINUTE,
): Record<string, BeatTiming> {
  const wpm = wordsPerMinute > 0 ? wordsPerMinute : WORDS_PER_MINUTE;
  const out: Record<string, BeatTiming> = {};
  let at = 0;
  let onVoiceTrack = true;
  for (const beat of beats) {
    const words = beat.lines.reduce((sum, l) => sum + wordsOf(wordsNow(l.id, l.words, drafts)), 0);
    const voices = beat.lines.map((l) => voiceBy[l.id]);
    const recorded =
      beat.lines.length > 0 &&
      beat.lines.every((l, k) => {
        const v = voices[k];
        return (
          !(l.id in drafts) &&
          !l.words_changed &&
          v !== undefined &&
          !v.words_changed &&
          (v.dur_sec ?? 0) > 0 &&
          Boolean(v.path)
        );
      });
    onVoiceTrack &&= recorded;
    let start = at;
    let dur = (words / wpm) * 60;
    if (recorded) {
      const heard = voices as VoiceLine[];
      const from = Math.min(...heard.map((v) => v.start_sec ?? 0));
      dur = Math.max(...heard.map((v) => (v.start_sec ?? 0) + (v.dur_sec ?? 0))) - from;
      if (onVoiceTrack) start = from;
    }
    out[beat.id] = { start, dur, est: !recorded, words };
    at = start + dur;
  }
  return out;
}

/** `voice.lines` by line id; anything but a list (no voice yet, a failed call) is no voice. */
export function voiceByLine(answer: unknown): Record<string, VoiceLine> {
  const list: VoiceLine[] = Array.isArray(answer) ? answer : [];
  return Object.fromEntries(list.filter((line) => line.node).map((line) => [line.node, line]));
}

export const isOverItsTime = (beat: Beat, timing: BeatTiming | undefined): boolean =>
  Boolean(beat.target_sec && timing && timing.dur > beat.target_sec * OVER_SCENE);

export type Fit = { kind: 'fits' } | { kind: 'over' | 'short'; seconds: number };

export interface Summary {
  /** Where the last scene ends: the pauses between lines count. */
  spoken: number;
  estimated: boolean;
  words: number;
  scenes: number;
  approved: number;
  /** Scenes that need the owner: waiting for an OK, or with unsaved words. */
  waiting: number;
  /** Seconds chosen for the whole script, when every scene has a plan. */
  chosen: number | null;
  fit: Fit | null;
}

export function summarize(
  beats: readonly Beat[],
  timings: Readonly<Record<string, BeatTiming>>,
  drafts: Drafts,
  /** The length the owner chose on New project, when the service says it; else the scenes' planned seconds add up. */
  chosenSec?: number | null,
): Summary {
  const all = beats.map((b) => timings[b.id]).filter((t): t is BeatTiming => t !== undefined);
  const spoken = all.reduce((end, t) => Math.max(end, t.start + t.dur), 0);
  const planned = beats.length > 0 && beats.every((b) => (b.target_sec ?? 0) > 0);
  const chosen =
    chosenSec && chosenSec > 0
      ? chosenSec
      : planned
        ? beats.reduce((sum, b) => sum + (b.target_sec ?? 0), 0)
        : null;
  let fit: Fit | null = null;
  if (chosen !== null) {
    const gap = spoken - chosen;
    const seconds = Math.max(1, Math.round(Math.abs(gap)));
    if (Math.abs(gap) <= chosen * OFF_SCRIPT) fit = { kind: 'fits' };
    else fit = { kind: gap > 0 ? 'over' : 'short', seconds };
  }
  return {
    spoken,
    estimated: all.some((t) => t.est),
    words: all.reduce((sum, t) => sum + t.words, 0),
    scenes: beats.length,
    approved: beats.filter((b) => isApproved(b) && !isDrafted(b, drafts)).length,
    waiting: beats.filter((b) => needsOwner(b, drafts)).length,
    chosen,
    fit,
  };
}

/** The scene "Go to the next one" leads to: one that waits and has no unsaved edit, else any that needs the owner. */
export const firstToReview = (beats: readonly Beat[], drafts: Drafts): Beat | undefined =>
  beats.find((b) => isWaiting(b) && !isDrafted(b, drafts)) ?? beats.find((b) => needsOwner(b, drafts));

/** After OK on `beat`: the next waiting scene, wrapping round, skipping scenes with unsaved edits. */
export function nextToReview(beats: readonly Beat[], beat: Beat, drafts: Drafts): Beat | undefined {
  const at = beats.indexOf(beat);
  return beats
    .slice(at + 1)
    .concat(beats.slice(0, at))
    .find((b) => isWaiting(b) && !isDrafted(b, drafts));
}

/** ElevenLabs bills a character a credit; a line with an up-to-date take costs nothing again. */
export function creditsFor(beats: readonly Beat[], voiceBy: Readonly<Record<string, VoiceLine>>): number {
  return beats
    .flatMap((b) => b.lines)
    .filter((l) => !voiceBy[l.id]?.path || voiceBy[l.id]?.words_changed || l.words_changed)
    .reduce((sum, l) => sum + l.words.length, 0);
}

/**
 * What an OK on this scene spends, said before the press: each OK records that scene's voice, and the last one
 * starts the voice step for the whole script. Null when the voice is free (local engine, no key) or nothing is owed.
 */
export function okCostText(
  beats: readonly Beat[],
  beat: Beat,
  voiceBy: Readonly<Record<string, VoiceLine>>,
  paid: boolean,
): string | null {
  if (!paid) return null;
  const last = beats.every((b) => b.id === beat.id || !isWaiting(b));
  const credits = creditsFor(last ? beats.filter((b) => b.state !== 'cut') : [beat], voiceBy);
  if (credits === 0) return null;
  return last
    ? `OK starts the voice recording: about ${credits.toLocaleString('en-US')} ElevenLabs credits`
    : `OK records this scene's voice: about ${credits.toLocaleString('en-US')} ElevenLabs credits`;
}
