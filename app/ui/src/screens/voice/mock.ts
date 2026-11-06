// The screen on fixture answers (add ?mock to the address; ?mock=nokey and ?mock=fresh for those states).
// Reads come from web/screens/voice.fixture.json. Every call that would spend credits answers a 402, so no click can
// spend anything.
import { ServiceError, type ServiceClient } from '../../lib/service/client';
import type {
  CastAnswer,
  CostAnswer,
  LineCheck,
  MusicCue,
  MusicPlan,
  VoiceChoice,
  VoiceCheck,
  VoiceView,
} from './types';

/** The two things of the service client this screen uses, so the fixtures can stand in for it. */
export type VoiceService = Pick<ServiceClient, 'call' | 'on'>;

interface Fixture {
  view: VoiceView;
  check: VoiceCheck;
  cast: CastAnswer;
  voices: { voices: VoiceChoice[] };
  plan: MusicPlan;
  takes: Record<string, { versions: { v: number; path: string }[]; plays: number }>;
}

type Params = Record<string, unknown>;

const REFUSED = () => new ServiceError('ElevenLabs refused: out of credits', 'billing');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const later = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(copy(value)), 60));

export type MockMode = '' | 'nokey' | 'fresh';

export async function createMockService(mode: MockMode, withPeaks: boolean): Promise<VoiceService> {
  const fixture = (await (await fetch('/screens/voice.fixture.json')).json()) as Fixture;
  if (mode === 'fresh') {
    for (const cue of fixture.plan.cues) {
      delete cue.path;
      cue.state = 'planned';
    }
  }
  const lineCheck = (id: unknown): LineCheck | undefined => fixture.check.lines.find((l) => l.id === id);
  const cueOf = (id: unknown): MusicCue | undefined => fixture.plan.cues.find((c) => c.id === id);

  async function call(type: string, params: Params = {}): Promise<unknown> {
    switch (type) {
      case 'voicemusic.view':
        return later(fixture.view);
      case 'voice.check':
        return later(fixture.check);
      case 'voice.list':
        return later({
          speaker: 'Mark',
          needs_key:
            mode === 'nokey'
              ? 'The voice and music come from ElevenLabs, and no ElevenLabs API key is saved. Add one in Settings › Keys. Nothing is spoken until then.'
              : null,
        });
      case 'cast.get':
        return later(fixture.cast);
      case 'cast.set':
        fixture.cast.cast = params.cast as CastAnswer['cast'];
        fixture.cast.set = true;
        return later(fixture.cast);
      case 'voices.list':
        return later(mode === 'nokey' ? { voices: [], reason: 'no_key' } : fixture.voices);
      case 'music.plan.get':
      case 'music.cue.set':
      case 'music.cue.ok':
      case 'music.plan.make':
        return later(fixture.plan);
      case 'music.cue.make': {
        if (params.confirm) throw REFUSED();
        const cue = cueOf(params.cue);
        return later({ needs_confirm: true, seconds: cue?.to_sec, credits_estimate: cue?.credits });
      }
      case 'voice.line.set': {
        const text = lineCheck(params.line)?.text ?? '';
        const retake =
          params.tags !== undefined || params.role !== undefined || params.stability !== undefined;
        if (params.confirm) throw REFUSED();
        const chars = text.length;
        const answer: CostAnswer = retake
          ? { retake, credits: chars, needs_confirm: !params.dry }
          : { retake: false, credits: 0 };
        return later(answer);
      }
      case 'voice.line.take': {
        if (params.confirm) throw REFUSED();
        const chars = lineCheck(params.line)?.text.length ?? 0;
        return later({ needs_confirm: true, characters: chars, credits_estimate: chars });
      }
      case 'node.list':
        return later({
          nodes: Object.entries(fixture.takes).map(([id, takes]) => ({ id, kind: 'line', ...takes })),
        });
      case 'audio.peaks': {
        if (!withPeaks) throw new ServiceError('unknown', 'unknown_type');
        let seed = 7;
        const buckets = Number(params.buckets);
        return later({
          peaks: Array.from({ length: buckets }, (_, i) => {
            seed = (seed * 9301 + 49297) % 233280;
            return 0.15 + (seed / 233280) * 0.85 * Math.abs(Math.sin(i / 3));
          }),
        });
      }
      case 'node.pick':
        return later({ node: params.node, plays: params.v });
      case 'node.edit':
        return later({});
      case 'options.get':
        return later({ options: [] });
      default:
        throw new ServiceError(`the mock has no ${type}`, 'unknown_type');
    }
  }

  return {
    call: call as VoiceService['call'],
    on: (() => () => undefined) as VoiceService['on'],
  };
}
