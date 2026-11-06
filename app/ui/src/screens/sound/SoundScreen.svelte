<!-- Sound (stage 6): sounds on the story's key moments (about one every 1.75 s, your library first). One shot at a time: its picture with the narration and the
     sound bars on one clock, the list of its sounds, the open sound's details, and the price to make what is missing.
     Paid sounds only after the cost is shown (MakeBar). Nothing here spends credits by itself. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import OptionsRow from '../../lib/components/OptionsRow.svelte';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import StageMenu from '../../lib/components/StageMenu.svelte';
  import StagePanel from '../../lib/components/StagePanel.svelte';
  import type { Caller } from '../../lib/stage-tools.svelte';
  import StepCostOk from '../../lib/components/StepCostOk.svelte';
  import { fileUrl } from '../../lib/files';
  import { pageParam } from '../../lib/page';
  import { useProblems, useProject, useRouter, useScreenBar, useService } from '../../lib/stores/context';
  import { ActiveWork } from '../../lib/review/active-work.svelte';
  import { waitingWords } from '../../lib/review/waiting';
  import { stageById, statusFor } from '../../lib/stages';
  import { serviceApi, type SoundApi } from './api';
  import { fixtureApi } from './fixture';
  import MakeBar from './MakeBar.svelte';
  import { ShotPlayback, type PlayPlan } from './playback.svelte';
  import ShotChips from './ShotChips.svelte';
  import ShotPanel from './ShotPanel.svelte';
  import SoundGate from './SoundGate.svelte';
  import SoundList from './SoundList.svelte';
  import { SoundState } from './sound-state.svelte';
  import { motionDone, okState, REREAD_WHILE_WAITING_MS } from './sound';

  const client = useService();
  const router = useRouter();
  const problems = useProblems();
  const bar = useScreenBar();
  const project = useProject();

  let sound = $state<SoundState>();
  let video = $state<HTMLVideoElement | null>(null);
  let changeOpen = $state(false);
  const playback = new ShotPlayback();
  /** The screenshot fixture shows no options: they would ask (and run on) the real project. */
  const onFixture = import.meta.env.DEV && pageParam('fixture') !== null;
  /** What the service is really doing for this project's Sound (a run, a queue, a drained restart), for the gate. */
  const work = new ActiveWork(client, project, stageById('sound'), onFixture);
  onMount(() => work.start());
  /** The sound step was skipped: no sound design in this video, said plainly. */
  const skipped = $derived(
    (statusFor(stageById('sound'), project.statuses)?.steps ?? []).some((step) => step.state === 'skipped'),
  );
  const gateWaits = $derived(
    !onFixture && work.queued !== null
      ? waitingWords(stageById('sound'), project.statuses, 'the sounds', work.queued)
      : null,
  );

  onMount(() => {
    let disposed = false;
    const fixture = pageParam('fixture');
    const open: Promise<SoundApi> =
      fixture === null ? Promise.resolve(serviceApi(client)) : fixtureApi(fixture);
    const stopListening = [
      // 'sfx.changed' was listened to here but the service never emits it (grep of mfx-service-v3/src): dropped
      ...['node.changed', 'work.active'].map((event) =>
        client.on(event, () => {
          if (sound && !sound.making) void sound.load(true);
        }),
      ),
      client.on<{ up: boolean }>('bridge.state', (state) => {
        if (state.up) void sound?.load();
      }),
    ];
    void open.then((api) => {
      if (disposed) return;
      sound = new SoundState(api, problems, router.query.get('shot'));
      void sound.load();
    });
    return () => {
      disposed = true;
      for (const stop of stopListening) stop();
      playback.stop();
      sound?.dispose();
    };
  });

  // While there is no list yet (motion not done, or Mortiflix listing), a missed push must not leave the screen waiting.
  const waiting = $derived(sound?.mode === 'noplan' || Boolean(sound?.listingSince));
  $effect(() => {
    if (!waiting) return;
    const reread = setInterval(() => void sound?.load(true), REREAD_WHILE_WAITING_MS);
    return () => clearInterval(reread);
  });

  // Moving to another shot stops what is playing and starts the playhead over.
  $effect(() => {
    void sound?.shotId;
    playback.stop();
  });

  const shot = $derived(sound?.shot);
  const cues = $derived(sound?.cues ?? []);
  const cue = $derived(sound?.cue);
  const live = $derived(sound?.live ?? []);
  const ok = $derived(okState(live));
  const gateReady = $derived(sound ? motionDone(sound.motion) && sound.canPlan : false);

  // The one gradient button of the screen: OK shot when it can be used, List the sounds at the gate.
  $effect(() => {
    bar.ownPrimary = sound?.mode === 'plan' ? ok.kind === 'ready' : gateReady;
  });

  // The top bar's count is this screen's own: every sound that is not cut, and how many are OK.
  $effect(() => {
    const kept = sound?.plan?.cues.filter((entry) => entry.status !== 'cut') ?? [];
    const motion = sound?.motion;
    bar.count = kept.length
      ? `${kept.filter((entry) => entry.status === 'ok').length} of ${kept.length} sounds OK`
      : motion?.total
        ? `${motion.ok} of ${motion.total} shots OK`
        : undefined;
  });

  const playPlan = $derived<PlayPlan | null>(
    sound && shot
      ? {
          span: shot.to - shot.from,
          from: shot.from,
          narration: sound.plan?.base ? fileUrl(sound.plan.base) : undefined,
          video: sound.media?.media?.path ? video : null,
          videoFrom: sound.media?.media?.from_sec ?? 0,
          sounds: cues
            .filter((c) => c.status !== 'cut' && c.file)
            .map((c) => ({ at: c.at_sec - shot.from, url: fileUrl(c.file ?? ''), gainDb: c.gain_db ?? 0 })),
        }
      : null,
  );

  const sounds = $derived(sound?.plan?.summary.cues ?? 0);

  /** On the fixture the panels never reach the real service. */
  const offline: Caller = { call: () => Promise.reject(new Error('not on the fixture')) };
  const mixWhy = $derived(
    !sound?.plan ? 'List the sounds first' : sound.making || sound.busy ? 'Wait until it is done' : undefined,
  );
</script>

<div class="sound">
  <ScreenHead
    kicker="Stage 6 · Sound"
    title="Sounds on the story's key moments"
    help="About one sound every 1.75 s, on the moments that carry the story, each as long as its motion. Your library goes first; only what it doesn't have is made new."
  >
    {#snippet actions()}
      <StageMenu
        stage="sound"
        extra={[
          {
            label: 'Mix the sounds into the voice and music',
            run: () => sound?.mix(),
            why: mixWhy,
          },
        ]}
      />
    {/snippet}
  </ScreenHead>
  <StagePanel stage="sound" service={onFixture ? offline : undefined} />
  <StepCostOk step="sound" />
  {#if skipped}
    <p class="skipped">
      <b>Sound design was skipped for this video.</b> No sound effects are added; the video has the voice and music
      only.
    </p>
  {/if}
  {#if !sound || sound.mode === 'loading'}
    <LoadingState text="Loading the sounds…" />
  {:else if sound.mode === 'coming'}
    <EmptyState
      title="Coming in this build"
      body="The sound step is not in this version of the service yet."
    />
  {:else if sound.mode === 'error'}
    <ErrorState title="Couldn't load the sounds" detail={sound.error} onretry={() => void sound?.load()} />
  {:else if sound.mode === 'noplan' || !sound.plan || !shot}
    <SoundGate
      motion={sound.motion}
      ready={gateReady}
      busy={sound.busy}
      listingSince={sound.listingSince}
      listedNone={sound.listedNone}
      working={work.here && !onFixture}
      waits={gateWaits}
      why={sound.cantPlanWhy}
      checkedAt={sound.checkedAt}
      onlist={() => void sound?.listTheSounds()}
      oncheck={async () => await sound?.load()}
    />
  {:else}
    {#if !onFixture}
      <OptionsRow
        stage="sound"
        target={cue?.id}
        targetLabel={cue ? `${cue.what} in shot ${shot.number}` : `shot ${shot.number}`}
        onrun={() => void sound?.load(true)}
      />
    {/if}
    <ShotChips
      plan={sound.plan}
      shotId={shot.id}
      making={Boolean(sound.making)}
      onpick={(id) => sound?.selectShot(id)}
    />
    <ShotPanel
      {shot}
      {cues}
      selectedId={cue?.id}
      media={sound.media?.media}
      {ok}
      busy={Boolean(sound.busy)}
      {playback}
      {playPlan}
      bind:video
      onpickcue={(picked) => sound?.selectCue(picked.id)}
      onok={() => void sound?.signOffShot()}
    />
    <SoundList {sound} {shot} {playback} total={sounds} bind:changeOpen />
    <MakeBar {sound} />
  {/if}
</div>

<style>
  .sound {
    display: grid;
    /* one column the screen wide: a wide row wraps or scrolls inside, never pushes the page past the window */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-24);
    min-width: 0;
  }
  .skipped {
    color: var(--muted);
    font-size: var(--t14);
  }
</style>
