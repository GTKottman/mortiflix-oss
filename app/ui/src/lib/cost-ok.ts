// Cost first for the steps Mortiflix would start by itself (service src/svc/paidgate.mjs): the voice, the music, the
// new sounds. The service waits with needs_you {kind:'cost_ok'} until `step.confirm_cost`; these are the words.
import type { NeedsYou, StepCost } from './service/types';
import type { StageId } from './stages';

export type PaidStep = 'voice' | 'music' | 'sound';

export const COST_OK_WAITING = 'Waiting for your OK on the cost';

const READY: Record<PaidStep, string> = {
  voice: 'Ready to record the voice',
  music: 'Ready to make the music',
  sound: 'Ready to make the new sounds',
};
const GO: Record<PaidStep, string> = {
  voice: 'Make the voice',
  music: 'Make the music',
  sound: 'Make the sounds',
};

export const readyText = (step: PaidStep): string => READY[step];
export const goText = (step: PaidStep): string => GO[step];

/** "about 1,234 credits"; the amount is unknown until a plan exists. */
export function creditsText(credits: number | null | undefined): string {
  return typeof credits === 'number'
    ? `about ${credits.toLocaleString('en-US')} credits`
    : 'credits not known yet';
}

/** The project waits for the owner's OK on this step's cost (any step when none is given). */
export function isCostWait(need: NeedsYou | null | undefined, step?: string): boolean {
  return need?.kind === 'cost_ok' && (!step || need.step === step);
}

/** Home's Needs you and the Fix it strip: "Waiting for your OK on the cost: the voice, about 493 credits." */
export function costWaitText(need: NeedsYou): string {
  const what = need.step === 'voice' ? 'the voice' : need.step === 'music' ? 'the music' : 'the new sounds';
  return `${COST_OK_WAITING}: ${what}, ${creditsText(need.estimate_credits)}.`;
}

/** Show the Make button: something to pay, ask first is on, and the next version's cost isn't OK'd yet. */
export function showCostOk(cost: StepCost | null, ahead: boolean): boolean {
  if (!cost || cost.free || !cost.ask_first || cost.ok_now) return false;
  return cost.waiting || ahead;
}

/** The screens that hold this step's Make button with the cost (StepCostOk): the first is where to send the owner. */
export function costScreens(need: NeedsYou): StageId[] {
  if (need.step === 'sound') return ['sound'];
  if (need.step === 'music') return ['voice'];
  return ['voice', 'script'];
}
