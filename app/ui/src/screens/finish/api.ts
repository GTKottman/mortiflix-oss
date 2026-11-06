import { fileUrl, thumbUrl } from '../../lib/files';
import { isNotBuiltYet, type ServiceClient } from '../../lib/service/client';
import { filmFrom } from './finish';
import type {
  Check,
  ChecksAnswer,
  FilmInfo,
  FinalStatus,
  GraphAnswer,
  HandoffPlan,
  VoiceMusicAnswer,
} from './types';

const POSTER_WIDTH = 1280;

/** Everything the Finish screen asks of the outside: the service, or the review fixtures (never the service). */
export interface FinishApi {
  status(): Promise<FinalStatus>;
  /** Starts putting the video together (free, local). */
  make(): Promise<void>;
  /** false when nothing was running to stop (final.cancel `cancelled:false`). */
  cancel(): Promise<boolean | void>;
  film(): Promise<FilmInfo>;
  /** The last checks; null when the service has no checks.run. Any other failure throws: the screen says that
      nothing was checked (a check that did not run is never a pass). */
  checks(): Promise<Check[] | null>;
  /** The kept sounds on Sound and how many of them the owner has not OK'd yet; null when unknown. */
  sounds?(): Promise<{ kept: number; notOk: number } | null>;
  /** The address the player opens for this status. */
  playSrc(status: FinalStatus): string | undefined;
  /** The picture shown before play. */
  posterSrc(film: FilmInfo): string | undefined;
  /** Writes the ArtCraft file and opens it. */
  openInArtCraft(): Promise<void>;
}

export function serviceApi(client: ServiceClient): FinishApi {
  return {
    status: () => client.call<FinalStatus>('final.status'),
    make: async () => {
      await client.call('final.make');
    },
    cancel: async () => {
      const answer = await client.call<{ cancelled?: boolean } | undefined>('final.cancel');
      return answer?.cancelled !== false;
    },
    async film() {
      const [voice, graph, plan] = await Promise.all([
        client.call<VoiceMusicAnswer>('voicemusic.view'),
        client.call<GraphAnswer>('graph.get'),
        client.call<HandoffPlan>('handoff.plan'),
      ]);
      return filmFrom(graph, voice, plan);
    },
    async checks() {
      try {
        const answer = await client.call<Check[] | ChecksAnswer>('checks.run');
        return Array.isArray(answer) ? answer : (answer.checks ?? null);
      } catch (error) {
        if (isNotBuiltYet(error)) return null;
        throw error;
      }
    },
    async sounds() {
      try {
        const plan = await client.call<{ cues?: { status?: string; file?: string | null }[] }>('sfx.plan');
        // what the final mix takes (finalaudio.mjs / graph.mjs handoffPlan): every sound not cut that has a file
        const kept = (plan.cues ?? []).filter((cue) => cue.status !== 'cut' && cue.file);
        return { kept: kept.length, notOk: kept.filter((cue) => cue.status !== 'ok').length };
      } catch {
        return null; // no Sound step in this project or service: nothing to say
      }
    },
    playSrc: (status) => (status.file ? fileUrl(status.file) : undefined),
    posterSrc: (film) => (film.poster ? thumbUrl(film.poster, POSTER_WIDTH) : undefined),
    async openInArtCraft() {
      const written = await client.call<{ file: string }>('artcraft.write');
      await client.call('artcraft.open', { file: written.file });
    },
  };
}
