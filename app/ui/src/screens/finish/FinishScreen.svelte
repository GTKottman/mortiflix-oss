<!-- Finish: the finished video. A big player on the left; on the right one delivery panel (state, specs, Download),
     the file, what the film is made of, and ArtCraft as a quiet extra. Only a blocker or a failure shows in the
     Fix it strip, as one sentence. Owner plan: review/plans/51-finish-owner-redesign.md. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import VideoPlayer, { type VideoInfo } from '../../lib/components/VideoPlayer.svelte';
  import { pageParam } from '../../lib/page';
  import { useProblems, useRouter, useScreenBar, useService } from '../../lib/stores/context';
  import { serviceApi, type FinishApi } from './api';
  import ArtCraftLink from './ArtCraftLink.svelte';
  import DeliveryPanel from './DeliveryPanel.svelte';
  import FileDetails from './FileDetails.svelte';
  import { fixtureApi } from './fixture';
  import { headLede, specLine } from './finish';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { FinalVideo } from './final-video.svelte';
  import ProductionSummary from './ProductionSummary.svelte';
  import RenderCover from './RenderCover.svelte';

  const client = useService();
  const router = useRouter();
  const problems = useProblems();
  const bar = useScreenBar();

  let final = $state<FinalVideo>();
  let picture = $state<{ width: number; height: number } | null>(null);

  onMount(() => {
    bar.ownPrimary = true;
    let disposed = false;
    const fixture = pageParam('fixture');
    const open: Promise<FinishApi> =
      fixture === null ? Promise.resolve(serviceApi(client)) : fixtureApi(fixture);
    // A render job moving, or a shot or sound changing (the video may be out of date), reads the state again.
    const stops = ['render.job', 'node.changed'].map((event) =>
      client.on(event, () => void final?.refresh()),
    );
    void open.then((api) => {
      if (disposed) return;
      final = new FinalVideo(api, problems, (path) => router.go(path));
      void final.start();
    });
    return () => {
      disposed = true;
      for (const stop of stops) stop();
      final?.dispose();
    };
  });

  $effect(() => final?.publishProblems());

  const onMetadata = (info: VideoInfo) => (picture = { width: info.width, height: info.height });
  const title = $derived(final?.film?.title ?? '');
  const path = $derived(final?.status.file ?? '');
</script>

{#if final && final.loaded}
  {@const f = final}
  {#snippet earlier()}Earlier version. {f.status.stale_why ||
      'Something changed after it was made.'}{/snippet}
  <div class="finish">
    <ScreenHead title={title || 'Your video'} help={headLede(f.status.state, f.lost)}>
      {#snippet kicker()}
        {#if f.lost}<StatusMark mark="bad" text="File missing" />
        {:else if f.status.state === 'done'}<StatusMark mark="ok" text="Video ready" />
        {:else if f.status.state === 'stale'}<StatusMark mark="fix" text="Out of date" />
        {:else if f.status.state === 'rendering'}<StatusMark mark="busy" text="Making the video" />
        {:else}Finish{/if}
      {/snippet}
    </ScreenHead>
    <div class="columns">
      <div class="video">
        <VideoPlayer
          src={f.playSrc}
          label="The final video"
          poster={f.posterSrc}
          duration={f.status.length_sec}
          fps={f.film?.fps}
          missing={f.lost}
          download={f.playSrc ? { href: f.playSrc, name: `${title || 'video'}.mp4` } : undefined}
          banner={f.status.state === 'stale' ? earlier : undefined}
          onmetadata={onMetadata}
          onmissing={() => (f.lost = true)}
        >
          {#snippet empty()}<RenderCover status={f.status} />{/snippet}
        </VideoPlayer>
      </div>
      <aside aria-label="Delivery">
        <div class="block">
          <DeliveryPanel
            status={f.status}
            lost={f.lost}
            starting={f.starting}
            stopping={f.stopping}
            blocked={f.blocker !== null}
            specs={specLine(f.status, f.film, picture)}
            href={f.playSrc}
            saveAs={`${title || 'video'}.mp4`}
            {path}
            onmake={() => void f.make()}
            oncancel={() => void f.cancel()}
            onartcraft={() => f.openInArtCraft()}
          />
        </div>
        {#if f.readable && !f.lost && path}<div class="block"><FileDetails {path} /></div>{/if}
        {#if f.film}<div class="block"><ProductionSummary counts={f.film.counts} leftOut={f.status.audio?.left_out ?? []} /></div>{/if}
        <div class="block"><ArtCraftLink open={() => f.openInArtCraft()} /></div>
      </aside>
    </div>
  </div>
{:else}
  <LoadingState text="Looking at the video…" />
{/if}

<style>
  .finish {
    display: grid;
    gap: var(--s-24);
    width: 100%;
    min-width: 0;
  }
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 68fr) minmax(300px, 32fr);
    gap: var(--s-32);
    align-items: start;
    min-width: 0;
  }
  .video {
    width: min(100%, calc((100vh - 270px) * 16 / 9));
    min-width: 0;
  }
  aside {
    display: grid;
    gap: var(--s-24);
    align-content: start;
    min-width: 0;
  }
  .block + .block {
    padding-top: var(--s-24);
    border-top: 1px solid var(--line);
  }
  @media (max-width: 1199px) {
    .columns {
      grid-template-columns: minmax(0, 1fr);
    }
    .video {
      width: 100%;
    }
  }
</style>
