import type { ServiceClient } from '../../lib/service/client';
import type {
  CueChange,
  GraphAnswer,
  MakeAnswer,
  MakeScope,
  MixAnswer,
  MotionProgress,
  PreviewAnswer,
  ShotMedia,
  SoundPlan,
} from './types';

/** What the Sound screen asks of the outside: the service, or the review fixtures (never the service). */
export interface SoundApi {
  /** The sound list; `plan` is null while no sounds are listed yet. */
  plan(): Promise<{ plan: SoundPlan | null; canPlan: boolean; why?: string }>;
  /** How far the motion stage is; null when the service cannot say. */
  motion(): Promise<MotionProgress | null>;
  /** The shot's own picture or clip; null when it is not made. */
  media(nodeId: string): Promise<ShotMedia | null>;
  /** Lists the sounds from the motion and the library (free). */
  makePlan(): Promise<void>;
  change(cue: string, change: CueChange): Promise<void>;
  signOff(cue: string): Promise<void>;
  cut(cue: string, cut: boolean): Promise<void>;
  /** What making would cost. Nothing is spent. */
  quote(scope: MakeScope): Promise<MakeAnswer>;
  /** Makes the sounds and spends the credits. Only after the owner saw the cost. */
  make(scope: MakeScope): Promise<MakeAnswer>;
  /** Mixes the voice and music with every kept sound into out/sound/final-mix.wav (ffmpeg, free). */
  mix(): Promise<MixAnswer>;
  /** Stops a running make after the sound being made now (that one is never cut off: it may be paid). */
  cancel(): Promise<void>;
}

export function serviceApi(client: ServiceClient): SoundApi {
  return {
    async plan() {
      const answer = await client.call<SoundPlan>('sfx.plan');
      return {
        plan: answer.cues?.length ? answer : null,
        canPlan: Boolean(answer.can_plan),
        why: answer.why ?? '',
      };
    },
    async motion() {
      try {
        const graph = await client.call<GraphAnswer>('graph.get');
        const shots = (graph.nodes ?? []).filter((node) => node.kind === 'shot');
        // the Motion screen's own OKs (motion.scene.approve) are the truth: the canvas shot decisions are not set by it
        // (d4fd, 2026-11-02: 7 of 7 scenes approved, Sound said "0 of 7 shots OK")
        const scenes = await client
          .call<{ scenes?: { state?: string }[] }>('motion.scene.get')
          .then((answer) => answer.scenes ?? [])
          .catch(() => []);
        return scenes.length
          ? {
              total: scenes.length,
              ok: scenes.filter((scene) => scene.state === 'ok').length,
              nodes: shots.map((node) => ({ id: node.id, beat: node.beat })),
            }
          : {
              total: shots.length,
              ok: shots.filter((node) => node.state === 'ok' || node.state === 'cut').length,
              nodes: shots.map((node) => ({ id: node.id, beat: node.beat })),
            };
      } catch {
        return null;
      }
    },
    async media(nodeId) {
      try {
        const answer = await client.call<PreviewAnswer>('preview.plan', { scope: 'shot', node: nodeId });
        return answer.shots?.[0]?.media ?? null;
      } catch {
        return null;
      }
    },
    async makePlan() {
      await client.call('sfx.plan.make');
    },
    async change(cue, change) {
      await client.call('sfx.set', { cue, ...change });
    },
    async signOff(cue) {
      await client.call('sfx.ok', { cue });
    },
    async cut(cue, cut) {
      await client.call('sfx.cut', cut ? { cue } : { cue, cut: false });
    },
    quote: (scope) => client.call<MakeAnswer>('sfx.make', { ...scope }),
    make: (scope) => client.call<MakeAnswer>('sfx.make', { ...scope, confirm: true }),
    mix: () => client.call<MixAnswer>('sfx.mix'),
    async cancel() {
      await client.call('sfx.cancel');
    },
  };
}
