// Cost first (service src/svc/paidgate.mjs): a paid step waits for the owner's OK on its cost. The words the app says
// for it, when the Make button shows, the Fix it strip (no Resume: it would only wait again) and Home's Needs you.
import { describe, expect, it } from 'vitest';
import {
  costScreens,
  costWaitText,
  creditsText,
  goText,
  isCostWait,
  readyText,
  showCostOk,
} from '../src/lib/cost-ok';
import { pauseView } from '../src/lib/pause';
import { openNameOf, openScreenOf, screenOf, whyText } from '../src/screens/home/projects';
import type { HomeProject } from '../src/screens/home/types';
import type { StepCost } from '../src/lib/service/types';
import { voiceWaiting } from '../src/screens/voice/waiting';

const need = { kind: 'cost_ok', cause: 'cost_ok', step: 'voice', estimate_credits: 493, text: 'Waiting…' };
const cost = (over: Partial<StepCost> = {}): StepCost => ({
  step: 'voice',
  estimate_credits: 493,
  free: false,
  voice: { name: 'Tracy K' },
  ok_now: false,
  ask_first: true,
  waiting: false,
  ...over,
});

describe('cost first', () => {
  it('says the step, the credits and the button', () => {
    expect(readyText('voice')).toBe('Ready to record the voice');
    expect(goText('voice')).toBe('Make the voice');
    expect(creditsText(1234)).toBe('about 1,234 credits');
    expect(creditsText(null)).toBe('credits not known yet');
    expect(costWaitText(need)).toBe('Waiting for your OK on the cost: the voice, about 493 credits.');
  });

  it('shows the Make button only when something is owed and not OK’d yet', () => {
    expect(showCostOk(cost({ waiting: true }), false)).toBe(true);
    expect(showCostOk(cost(), true)).toBe(true);
    expect(showCostOk(cost(), false)).toBe(false);
    expect(showCostOk(cost({ waiting: true, ok_now: true }), false)).toBe(false);
    expect(showCostOk(cost({ waiting: true, free: true }), false)).toBe(false);
    expect(showCostOk(cost({ waiting: true, ask_first: false }), false)).toBe(false);
    expect(showCostOk(null, true)).toBe(false);
  });

  it('knows a cost wait from other pauses', () => {
    expect(isCostWait(need)).toBe(true);
    expect(isCostWait(need, 'voice')).toBe(true);
    expect(isCostWait(need, 'music')).toBe(false);
    expect(isCostWait({ cause: 'login' })).toBe(false);
    expect(isCostWait(null)).toBe(false);
  });

  it('the Fix it strip says it and offers no Resume: on the screen with the Make button nothing', () => {
    expect(pauseView('paused', need, 'voice')).toEqual({
      text: 'Waiting for your OK on the cost: the voice, about 493 credits.',
      kind: 'warn',
      action: null,
    });
    expect(pauseView('paused', need, 'script')?.action).toBeNull();
  });

  it('the Fix it strip leads to the screen with the Make button from anywhere else', () => {
    expect(pauseView('paused', need, 'motion')?.action).toEqual({
      label: 'Go to Voice & music',
      run: 'cost',
    });
    expect(pauseView('paused', { ...need, step: 'music' }, 'script')?.action?.label).toBe(
      'Go to Voice & music',
    );
    expect(pauseView('paused', { ...need, step: 'sound' }, 'voice')?.action?.label).toBe('Go to Sound');
    expect(pauseView('paused', { ...need, step: 'sound' }, 'sound')?.action).toBeNull();
    expect(costScreens({ ...need, step: 'sound' })).toEqual(['sound']);
  });

  it('a gave-up pause says the service’s own sentence, before "Likely cause", with its action', () => {
    const view = pauseView('paused', {
      cause: 'gave-up',
      takeover: true,
      text: "The stills couldn't be finished by the studio: render timed out. Likely cause: GPU busy. Check the log.",
    });
    expect(view?.text).toBe("The stills couldn't be finished by the studio: render timed out.");
    expect(view?.action?.run).toBe('resume'); // a paused project always offers Resume first
    expect(view?.second?.run).toBe('takeover');
    expect(pauseView('paused', { cause: 'gave-up' })?.text).toBe('The AI got stuck on this step.');
  });

  it('Home’s Needs you lists the cost wait and opens the screen with the Make button', () => {
    const project = { id: 'p', state: 'paused', stage: 4, needs_you: need } as unknown as HomeProject;
    expect(whyText(project)).toBe('Waiting for your OK on the cost: the voice, about 493 credits.');
    expect(openScreenOf(project)).toBe('voice');
    expect(openNameOf({ ...project, needs_you: { ...need, step: 'sound' } })).toBe('Sound');
    expect(openScreenOf({ ...project, needs_you: null })).toBe(screenOf(project));
  });

  it('the Voice screen no longer says the voice starts by itself', () => {
    const ready = voiceWaiting('ready', 0);
    expect(ready?.title).toBe('Ready to record the voice');
    expect(ready && 'making' in ready).toBe(false);
  });
});
