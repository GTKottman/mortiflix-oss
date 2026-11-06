// Opens the voice model once a project is open, keeps it fresh when the service says something changed, and tells
// the rest of the app what is wrong or waiting (the Fix it strip, the Next button).
import { untrack } from 'svelte';
import { useProblems, useProject, useRouter, useScreenBar, useService } from '../../lib/stores/context';
import { plural } from '../../lib/words';
import { createMockService, type MockMode, type VoiceService } from './mock';
import { VoiceModel } from './model.svelte';
import { VOICE_ACTIONS } from './review';

/** How long to wait for the open project before saying there is none. */
const PROJECT_GRACE_MS = 800;
/** On a screen taller than this the list of issues starts open. */
const TALL_SCREEN = 800;
const NOTICE_IDS = ['eleven-key', 'voice-err', 'music-err', 'voice-load', 'voice-takes'];

export interface VoiceSession {
  readonly model: VoiceModel | null;
  /** Long enough has passed with no project open. */
  readonly graceOver: boolean;
}

/** Call while a component is being created: it registers the effects. */
export function useVoiceSession(): VoiceSession {
  const client = useService();
  const router = useRouter();
  const project = useProject();
  let model = $state.raw<VoiceModel | null>(null);
  let graceOver = $state(false);

  // Starts on the real service, or on the fixtures with ?mock. `gone` says the project changed or the screen closed
  // while this was starting: the model made here is then closed at once.
  async function start(projectId: string, gone: () => boolean): Promise<VoiceModel | null> {
    const mock = import.meta.env.DEV ? router.query.get('mock') : null; // fixtures: dev builds only
    let service: VoiceService = client;
    if (mock !== null) {
      const mode: MockMode = mock === 'nokey' || mock === 'fresh' ? mock : '';
      service = await createMockService(mode, router.query.get('peaks') !== null);
    }
    const next = new VoiceModel(service, {
      line: router.query.get('line'),
      cue: router.query.get('cue'),
      issuesOpen: router.query.get('issues') !== null || innerHeight > TALL_SCREEN,
      project: projectId,
    });
    if (gone()) {
      next.dispose();
      return null;
    }
    model = next;
    await next.load();
    if (next.selectedLine && !gone()) void next.readTakes(next.selectedLine);
    return next;
  }

  $effect(() => {
    const timer = setTimeout(() => (graceOver = true), PROJECT_GRACE_MS);
    return () => clearTimeout(timer);
  });

  // One model per open project. Teardown (project changed, or the screen left: svelte.dev/docs/svelte/$effect) stops
  // its sound and its queue, so nothing plays or is paid for after the owner moved on.
  $effect(() => {
    const id = project.id;
    if (!id) return;
    let gone = false;
    let opened: VoiceModel | null = null;
    untrack(() => void start(id, () => gone).then((next) => (opened = next)));
    return () => {
      gone = true;
      (opened ?? untrack(() => model))?.dispose();
    };
  });

  // The service says something changed (another screen, a finished make): read again.
  $effect(() => {
    const current = model;
    if (!current) return;
    const stops = [
      client.on<{ all?: boolean; nodes?: { id: string }[] }>('node.changed', (data) => {
        const ids = (data?.nodes ?? []).map((n) => n.id);
        if (!data?.all && ids.length && !ids.some((id) => current.lineById(id))) return;
        current.forgetNodes(ids, Boolean(data?.all));
        current.reloadSoon();
      }),
      client.on('script.changed', () => current.reloadSoon()),
      client.on('activity', () => current.reloadSoon()),
      client.on('music.changed', () => {
        if (!current.music.busy) void current.music.load();
      }),
    ];
    return () => stops.forEach((stop) => stop());
  });

  useNotices(() => model);

  return {
    get model() {
      return model;
    },
    get graceOver() {
      return graceOver;
    },
  };
}

function useNotices(getModel: () => VoiceModel | null) {
  const problems = useProblems();
  const router = useRouter();
  const screenBar = useScreenBar();

  // Errors only ever show in the Fix it strip.
  $effect(() => {
    const key = getModel()?.noKey;
    if (key) {
      problems.raise({
        id: 'eleven-key',
        kind: 'warn',
        text: key,
        fix: {
          label: VOICE_ACTIONS.settings,
          run: async () => {
            router.go('/settings');
            return '';
          },
        },
      });
    } else problems.clear('eleven-key');
  });
  $effect(() => {
    const text = getModel()?.basket.error;
    if (text) problems.raise({ id: 'voice-err', kind: 'bad', text });
    else problems.clear('voice-err');
  });
  // A later read that failed keeps the last view on screen: say so, it may be old (the first failure is the
  // screen's own ErrorState).
  $effect(() => {
    const current = getModel();
    const text = current?.view ? current.loadError : null;
    if (current && text) {
      problems.raise({
        id: 'voice-load',
        kind: 'warn',
        text: `The voice could not be read again: ${text}. What shows may be old.`,
        fix: {
          label: 'Try again',
          run: async () => {
            await current.load();
            return current.loadError ? '' : 'Loaded.';
          },
        },
      });
    } else problems.clear('voice-load');
  });
  $effect(() => {
    const text = getModel()?.takesError;
    if (text) problems.raise({ id: 'voice-takes', kind: 'warn', text });
    else problems.clear('voice-takes');
  });
  $effect(() => {
    const current = getModel();
    const text = current?.music.error;
    if (current && text) {
      problems.raise({
        id: 'music-err',
        kind: 'bad',
        text: `The music could not load: ${text}`,
        fix: {
          label: 'Try again',
          run: async () => {
            current.music.error = null;
            await current.music.load();
            return 'Loaded.';
          },
        },
      });
    } else problems.clear('music-err');
  });
  $effect(() => () => NOTICE_IDS.forEach((id) => problems.clear(id)));

  // Next is honest: an outline with the reason, while anything is unmade or still to check.
  $effect(() => {
    const current = getModel();
    if (!current?.view) return;
    const queued = current.basket.size;
    const toReview = current.issues.length;
    screenBar.ownPrimary = queued > 0 || toReview > 0;
    screenBar.count = queued
      ? `${plural(queued, 'change')} not made`
      : toReview
        ? `${toReview} to review`
        : undefined;
  });
}
