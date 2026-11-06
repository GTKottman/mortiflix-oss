import { clockTenths } from '../../lib/time';
import type { Cue, MakeAnswer, MotionProgress, OkState, PlanShot, SoundPlan } from './types';

// The Sound screen's rules, free of markup so they can be tested.

/** ElevenLabs credits per second of a made sound. */
/** Fallback only: the service sends each row's cost (`credits`), measured from the real ElevenLabs calls. */
export const CREDITS_PER_SECOND = 12;

export const isNew = (cue: Cue): boolean => cue.source === 'generate';

/** A new sound that still has to be made (a cut one never is). */
export const isUnmade = (cue: Cue): boolean => isNew(cue) && !cue.file && cue.status !== 'cut';

/** What making this sound would cost; 0 when it is from the library or made. */
export const creditsFor = (cue: Cue): number =>
  cue.source === 'generate' && !cue.file
    ? (cue.credits ?? Math.max(1, Math.ceil(Math.max(0.5, cue.dur_sec) * CREDITS_PER_SECOND)))
    : 0;

export type CueMark = 'ok' | 'fix' | 'busy' | 'wait' | 'cut' | 'made';

/** The words and glyph for a sound's status. "Made · to check" has no colour (not signed off yet). */
export function cueStatus(cue: Cue, making: boolean): { mark: CueMark; text: string } {
  if (making && isUnmade(cue)) return { mark: 'busy', text: 'Making' };
  switch (cue.status) {
    case 'planned':
      return cue.failed
        ? { mark: 'fix', text: 'Came back nearly silent · make again' }
        : { mark: 'wait', text: 'Not made yet' };
    case 'ready':
      return { mark: 'made', text: 'Made · to check' };
    case 'ok':
      return { mark: 'ok', text: 'OK' };
    case 'cut':
      return cue.cut_by === 'finish' ? { mark: 'cut', text: `Left out by Finish${cue.note ? `: ${cue.note}` : ''}` } : { mark: 'cut', text: 'Cut' };
  }
}

const sameAs = (reuse: NonNullable<Cue['reuse']>): string => `Same sound as shot ${reuse.shot_number} at ${clockTenths(reuse.at_sec)}`;

/** The sound a row plays: the library file's own name when it comes from the library (the same file the panel's
 * source names), else the description the new sound is made from. */
export const soundName = (cue: Cue): string => (cue.source === 'library' && cue.library_name ? cue.library_name : cue.prompt);

/** The source chip in the sound list. */
export function sourceChip(cue: Cue): string {
  if (cue.source === 'library') return 'Library';
  if (cue.from_library) return 'Made before · free';
  if (cue.file) return 'New · made';
  if (cue.cached) return 'Made before · free';
  if (cue.reuse) return `${sameAs(cue.reuse)} · no extra credits`;
  return `New · ${creditsFor(cue)} credits`;
}

/** The source in the selected sound's facts. */
export function sourceFact(cue: Cue): string {
  if (cue.source === 'library') return `Your library${cue.library_name ? `: ${cue.library_name}` : ''}`;
  if (cue.from_library) return 'Made before, from your library (free)';
  if (!cue.file && cue.cached) return 'Made before in another project (free)';
  if (!cue.file && cue.reuse) return `${sameAs(cue.reuse)}: made once, no extra credits`;
  return cue.file ? 'New, made' : `New, about ${creditsFor(cue)} credits`;
}

export const liveCues = (plan: SoundPlan, shotId: string): Cue[] =>
  plan.cues.filter((cue) => cue.shot === shotId && cue.status !== 'cut');

export const shotSigned = (plan: SoundPlan, shotId: string): boolean =>
  liveCues(plan, shotId).every((cue) => cue.status === 'ok');

/** Every sound is made and OK'd. */
export const everyShotDone = (plan: SoundPlan): boolean =>
  plan.shots.every((shot) => shotSigned(plan, shot.id)) && !plan.cues.some(isUnmade);

/** A shot chip's extras: a check when all its sounds are OK, a spinner while making, "· N new". */
export function chipMark(plan: SoundPlan, shot: PlanShot, making: boolean): { glyph: string; news: string } {
  const live = liveCues(plan, shot.id);
  const waiting = live.filter(isUnmade).length;
  const signed = live.length > 0 && live.every((cue) => cue.status === 'ok');
  return { glyph: making && waiting ? '◌' : signed ? '✓' : '', news: waiting ? ` · ${waiting} new` : '' };
}

/** The motion is final: every shot OK or cut. Unknown progress does not block. */
export const motionDone = (motion: MotionProgress | null): boolean =>
  !motion || (motion.total > 0 && motion.ok === motion.total);

/** The gain for an audio element, from dB, never above full volume. */
export const gainFromDb = (decibels: number): number => Math.min(1, 10 ** (decibels / 20));

/** Where a time on the film's clock falls inside a shot, 0 to 1. */
export function shotFraction(shot: Pick<PlanShot, 'from' | 'to'>, time: number): number {
  const span = Math.max(0.1, shot.to - shot.from);
  return Math.max(0, Math.min(1, (time - shot.from) / span));
}

/** "13 new sounds" / "1 new sound" */
export const newSounds = (n: number): string => `${n} new sound${n === 1 ? '' : 's'}`;

/** Where a sound's bar sits along its shot, in percent. It ends where its motion ends, or before the next sound. */
export function markSpan(
  shot: Pick<PlanShot, 'from' | 'to'>,
  cues: readonly Cue[],
  index: number,
): { left: number; width: number } {
  const cue = cues[index];
  if (!cue) return { left: 0, width: 0 };
  const span = Math.max(0.1, shot.to - shot.from);
  const room = (cues[index + 1]?.at_sec ?? shot.to) - cue.at_sec;
  const length = Math.max(0.05, Math.min(cue.dur_sec, room - 0.08));
  return { left: (Math.max(0, cue.at_sec - shot.from) / span) * 100, width: (length / span) * 100 };
}

/** The OK shot button's state for a shot's live sounds. */
export function okState(live: readonly Cue[]): OkState {
  if (!live.length) return { kind: 'none' };
  if (live.every((cue) => cue.status === 'ok')) return { kind: 'signed' };
  const unmade = live.filter(isUnmade).length;
  if (unmade === 0 && live.some((cue) => cue.file && cue.status !== 'ok')) return { kind: 'ready' };
  return {
    kind: 'blocked',
    reason: unmade
      ? `${unmade} sound${unmade === 1 ? ' is' : 's are'} not made yet`
      : 'Nothing to OK in this shot',
  };
}

/** The sounds OK shot signs off: made, not yet OK, not cut. */
export const cuesToSignOff = (cues: readonly Cue[]): Cue[] =>
  cues.filter((cue) => cue.file && cue.status !== 'ok' && cue.status !== 'cut');

/** The shot after `shotId`, if there is one. */
export const shotAfter = (plan: SoundPlan, shotId: string): PlanShot | undefined =>
  plan.shots[plan.shots.findIndex((shot) => shot.id === shotId) + 1];

/** The shot to show after a load: the open one if it still exists, else the wanted one, else the first. */
export function shotToOpen(plan: SoundPlan, openId: string, wantedId: string | null): string {
  if (plan.shots.some((shot) => shot.id === openId)) return openId;
  const wanted = plan.shots.some((shot) => shot.id === wantedId) ? wantedId : null;
  return wanted ?? plan.shots[0]?.id ?? '';
}

/** The shot a one-shot price is asked for: the open one if it has sounds to make, else the first that has. */
export function shotToPrice(plan: SoundPlan, openId: string): PlanShot | undefined {
  const withNew = (shot: PlanShot) => plan.cues.some((cue) => cue.shot === shot.id && isUnmade(cue));
  return plan.shots.find((shot) => shot.id === openId && withNew(shot)) ?? plan.shots.find(withNew);
}

/** What to tell when making stopped early. */
export function stopNote(result: MakeAnswer, total: number): { billing: boolean; text: string } | null {
  if (!result.stopped) return null;
  const made = result.made?.length ?? 0;
  return result.stopped.billing
    ? {
        billing: true,
        text: `ElevenLabs said no (billing or limit). ${made} of ${total} sounds were made and nothing more was spent.`,
      }
    : {
        billing: false,
        text: `Stopped at one sound: ${result.stopped.error}. ${made} of ${total} were made.`,
      };
}

/** While the screen waits for the list, it reads again this often in case a push from the service was missed. */
export const REREAD_WHILE_WAITING_MS = 10_000;
