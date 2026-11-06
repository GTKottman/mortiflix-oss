<!-- Motion: ONE scene at a time. Watch it, mark what is wrong, collect the notes, then Request fix (all notes as one
     change) or Approve (the next scene is made, with every approved lesson). It works like Video Notes on the tablet:
     the video, its controls, note pins and filmstrip on the left, Mark this frame opens the Mark screen, and the notes,
     scenes and lessons sit on the right; below 1200 px it is all one column. One decision bar stays at the bottom.
     Owner plan: review/plans/11-motion-owner-redesign.md. Open #/motion?mock=review to see it without the studio. -->
<script lang="ts">
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import OptionsList from '../../lib/components/OptionsList.svelte';
  import OptionsRow from '../../lib/components/OptionsRow.svelte';
  import StageMenu from '../../lib/components/StageMenu.svelte';
  import StagePanel from '../../lib/components/StagePanel.svelte';
  import { ActiveWork } from '../../lib/review/active-work.svelte';
  import { reviewKeys } from '../../lib/review/keys';
  import { waitingWords } from '../../lib/review/waiting';
  import { stageById } from '../../lib/stages';
  import { useLiveReload } from '../../lib/review/live.svelte';
  import { pageParam } from '../../lib/page';
  import { useProblems, useProject, useRouter, useScreenBar, useService } from '../../lib/stores/context';
  import { motionApi } from './api';
  import ApproveDialog from './ApproveDialog.svelte';
  import DecisionBar from './DecisionBar.svelte';
  import { createMockService, isMockMode, MOCK_PILLS } from './fixture';
  import { playerKeys } from './keys';
  import FrameDrawDialog from './FrameDrawDialog.svelte';
  import MotionBriefForm from './MotionBriefForm.svelte';
  import MotionHead from './MotionHead.svelte';
  import MotionInspector from './MotionInspector.svelte';
  import { MotionSession, provideMotion } from './motion.svelte';
  import RequestFixDialog from './RequestFixDialog.svelte';
  import RestDialog from './RestDialog.svelte';
  import ScenePlayer from './ScenePlayer.svelte';
  import SceneTablet from './SceneTablet.svelte';
  import VersionRow from './VersionRow.svelte';
  import { LOAD_PROBLEM, PLAN_PROBLEM, PROBLEM, REREAD_WHILE_MAKING_MS } from './words';

  const client = useService();
  const project = useProject();
  const router = useRouter();
  const bar = useScreenBar();

  const param = (name: string): string | null => router.query.get(name) ?? pageParam(name);
  const mock = import.meta.env.DEV ? param('mock') : null; // fixtures: dev builds only
  const service = isMockMode(mock)
    ? createMockService({ mode: mock, seed: param('seed'), tablet: param('tabletdemo'), sync: param('sync') })
    : client;

  const motion = provideMotion(
    new MotionSession({
      api: motionApi(service),
      service,
      problems: useProblems(),
      projectId: () => project.id ?? '',
      asked: param('shot'),
      remember: (beat) => {
        const query = new SvelteURLSearchParams(location.hash.split('?')[1] ?? '');
        query.set('shot', beat);
        history.replaceState(null, '', `${location.pathname}${location.search}#/motion?${query}`);
      },
    }),
  );

  // The fixtures need no project; the real scenes load once the project is open.
  $effect(() => {
    if (isMockMode(mock) || project.id) void motion.load();
  });

  useLiveReload(
    service,
    ['lessons.changed', 'node.changed', 'motion.scene', 'notes.changed', 'videonotes.changed', 'work.active'],
    () => motion.load(),
  );

  // "Generating… so far" only while the service really works on Motion; otherwise say what it waits for.
  const work = new ActiveWork(client, project, stageById('motion'), isMockMode(mock));
  $effect(() => work.start());
  $effect(() => {
    motion.work = work;
    motion.waiting =
      anyMaking && work.idle
        ? waitingWords(stageById('motion'), project.statuses, 'the scenes', work.queued)
        : null;
  });

  // A missed push must not leave a scene "making" forever: read again every few seconds while one is made.
  const anyMaking = $derived(Object.keys(motion.makingSince).length > 0);
  $effect(() => {
    if (!anyMaking) return;
    const reread = setInterval(() => void motion.load(), REREAD_WHILE_MAKING_MS);
    return () => clearInterval(reread);
  });

  // Leaving the screen takes its warnings out of the Fix it strip (teardown: svelte.dev/docs/svelte/$effect).
  $effect(() => () => [PROBLEM, LOAD_PROBLEM, PLAN_PROBLEM].forEach((id) => motion.problems.clear(id)));

  $effect(() => service.on('sync.changed', () => void motion.checkSync()));
  $effect(() =>
    service.on<{ note: string; text?: string; error?: string }>('notes.transcribed', (event) =>
      motion.transcribed(event),
    ),
  );

  // The count in the top bar and the scene's own gradient button (Request fix or Approve).
  $effect(() => {
    bar.count = motion.scene
      ? `Scene ${motion.index + 1} of ${motion.total} · ${motion.done}/${motion.total} approved`
      : undefined;
    bar.ownPrimary = motion.total === 0 || motion.done !== motion.total;
  });

  $effect(() => {
    const stopReview = reviewKeys({ ok: () => motion.askApprove(), fix: () => motion.askFix() });
    const stopPlayer = playerKeys(motion);
    return () => {
      stopReview();
      stopPlayer();
    };
  });
</script>

{#snippet panel()}
  <StagePanel stage="motion" {service}>
    {#snippet brief()}<MotionBriefForm {service} />{/snippet}
  </StagePanel>
{/snippet}

{#if motion.failure}
  <ErrorState title="Could not load the scenes" detail={motion.failure} onretry={() => void motion.load()} />
{:else if !motion.loaded && !motion.soon}
  <LoadingState text="Loading the scenes…" />
{:else if !motion.scene}
  {#if !motion.soon}
    <div class="stage-tools"><StageMenu stage="motion" brief /></div>
    {@render panel()}
  {/if}
  <EmptyState
    title={motion.soon ? 'Motion is coming' : 'No scenes yet'}
    body={motion.soon
      ? 'This part comes in the next studio update. Nothing is lost.'
      : 'Write the script and make the look first. Scenes show here one at a time.'}
  />
{:else}
  <div class="motion">
    <div class="column">
      <div class="watch">
        <MotionHead />
        {@render panel()}
        <ScenePlayer />
      </div>
      <div class="review">
        <div class="under">
          <VersionRow />
          <SceneTablet />
        </div>
        <MotionInspector />
        {#if motion.scene.state !== 'waiting'}
          {#if isMockMode(mock)}
            <OptionsList
              options={MOCK_PILLS}
              targetLabel={`Scene ${motion.index + 1}`}
              run={async () => ({ does: 'Nothing is changed in the fixture.' })}
              answer={async () => undefined}
            />
          {:else}
            <OptionsRow
              stage="motion"
              target={motion.beat ?? undefined}
              targetLabel={`Scene ${motion.index + 1}`}
              onrun={() => void motion.load()}
            />
          {/if}
        {/if}
        <p class="keys">Space play · , . step a frame · M mark frame · F request fix · Enter approve scene</p>
      </div>
    </div>
    <DecisionBar />
  </div>
  {#if motion.marking}<FrameDrawDialog />{/if}
  {#if motion.dialog === 'fix'}<RequestFixDialog />{/if}
  {#if motion.dialog === 'approve'}<ApproveDialog />{/if}
  {#if motion.rest}<RestDialog />{/if}
{/if}

<style>
  .motion {
    display: grid;
    /* one column the screen wide: a wide row wraps or scrolls inside, never pushes the page past the window */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-24);
    min-width: 0;
  }
  .column,
  .watch,
  .review {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-24);
    align-content: start;
    min-width: 0;
  }
  .column {
    width: 100%;
    max-width: var(--motion-col);
    margin: 0 auto;
  }
  .under {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--s-8) var(--s-16);
  }
  .watch {
    gap: var(--s-12);
  }
  .keys {
    margin: 0;
    color: var(--faint);
    font-size: var(--t12);
  }
  /* no keyboard on a tablet: the keys are only noise there */
  @media (pointer: coarse) {
    .keys {
      display: none;
    }
  }
  .stage-tools {
    display: flex;
    justify-content: flex-end;
  }
  /* desktop: the video takes the room, and stays in view while a long note list scrolls beside it */
  @media (min-width: 1200px) {
    .under {
      justify-content: flex-start;
    }
    .column {
      grid-template-columns: minmax(0, 68fr) minmax(var(--motion-side-min-w), 32fr);
      max-width: none;
    }
    .watch {
      position: sticky;
      top: 0;
    }
  }
</style>
