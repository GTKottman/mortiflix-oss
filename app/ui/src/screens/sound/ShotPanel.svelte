<!-- The open shot at a glance: its picture on the left; its name, Play and OK shot, and the shot's clock on the right. -->
<script lang="ts">
  import type { ShotPlayback, PlayPlan } from './playback.svelte';
  import ShotHeader from './ShotHeader.svelte';
  import ShotPicture from './ShotPicture.svelte';
  import ShotTimeline from './ShotTimeline.svelte';
  import type { Cue, OkState, PlanShot, ShotMedia } from './types';

  interface Props {
    shot: PlanShot;
    cues: Cue[];
    selectedId: string | undefined;
    media: ShotMedia | null | undefined;
    ok: OkState;
    /** A change is being saved. */
    busy: boolean;
    playback: ShotPlayback;
    /** What Play shot plays; null while there is nothing to play. */
    playPlan: PlayPlan | null;
    /** The picture's video, so the playback can keep it in time with the sounds. */
    video: HTMLVideoElement | null;
    onpickcue: (cue: Cue) => void;
    onok: () => void;
  }

  let {
    shot,
    cues,
    selectedId,
    media,
    ok,
    busy,
    playback,
    playPlan,
    video = $bindable(null),
    onpickcue,
    onok,
  }: Props = $props();
</script>

<div class="panel" class:nopic={!media?.path}>
  <ShotPicture {media} shotNumber={shot.number} bind:video />
  <div class="side">
    <ShotHeader
      {shot}
      playing={playback.playing}
      {ok}
      {busy}
      onplay={() => playPlan && playback.toggle(playPlan)}
      {onok}
    />
    <ShotTimeline
      {shot}
      {cues}
      {selectedId}
      offset={playback.offset}
      onseek={(offset) => playPlan && playback.seek(playPlan, offset)}
      onpick={(picked) => {
        onpickcue(picked);
        if (playPlan) playback.seek(playPlan, Math.max(0, picked.at_sec - shot.from));
      }}
    />
  </div>
</div>

<style>
  .panel {
    display: grid;
    grid-template-columns: minmax(0, var(--shot-picture-w)) minmax(0, 1fr);
    gap: var(--s-32);
    align-items: start;
  }
  .panel.nopic {
    grid-template-columns: var(--shot-nopicture-w) minmax(0, 1fr);
  }
  /* tablet and phone: the picture above the timeline, both the screen wide (owner's tablet 2026-11-03) */
  @media (max-width: 999px) {
    .panel,
    .panel.nopic {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .side {
    display: grid;
    gap: var(--s-12);
    align-content: start;
    min-width: 0;
  }
</style>
