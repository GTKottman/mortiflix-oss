import type { SoundApi } from './api';
import type { MakeAnswer, SoundPlan } from './types';

// The review fixtures (web/screens/sound.fixture.json): the screen without the service.
// Open /app/?fixture=#/sound, ?fixture=allok#/sound (everything OK'd) or ?fixture=gate#/sound (motion not done).
// Every action does nothing and nothing paid is ever asked.

const NOTHING: MakeAnswer = { calls: 0, credits: 0 };

export async function fixtureApi(name: string): Promise<SoundApi> {
  const response = await fetch('/screens/sound.fixture.json');
  const plan = (await response.json()) as SoundPlan;
  if (name === 'allok') {
    for (const cue of plan.cues) {
      cue.file ??= `/fixture/${cue.id}.mp3`;
      cue.status = 'ok';
    }
    Object.assign(plan.summary, { to_make: 0, credits: 0, made: plan.summary.new });
  }
  const gate = name === 'gate';
  return {
    plan: async () => ({ plan: gate ? null : plan, canPlan: false }),
    motion: async () => (gate ? { total: 6, ok: 0, nodes: [] } : null),
    media: async () => null,
    makePlan: async () => undefined,
    change: async () => undefined,
    signOff: async () => undefined,
    cut: async () => undefined,
    quote: async (scope) =>
      'all' in scope
        ? { calls: plan.summary.to_make, credits: plan.summary.credits }
        : { ...NOTHING, calls: 2, credits: 40 },
    make: async () => NOTHING,
    mix: async () => ({ file: 'out/sound/final-mix.wav', sounds: plan.summary.cues, seconds: 94 }),
    cancel: async () => undefined,
  };
}
