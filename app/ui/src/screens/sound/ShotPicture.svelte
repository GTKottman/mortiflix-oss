<!-- The real frame the sounds belong to: the shot's clip (muted, played with Play shot) or its look picture.
     No picture is said plainly, never invented. -->
<script lang="ts">
  import { isVideoPath, thumbUrl, fileUrl } from '../../lib/files';
  import type { ShotMedia } from './types';

  interface Props {
    /** undefined = still asking, null = the shot has no picture. */
    media: ShotMedia | null | undefined;
    shotNumber: number;
    /** The clip's element, so Play shot can play it. */
    video?: HTMLVideoElement | null;
  }

  const LOOK_WIDTH = 800;

  let { media, shotNumber, video = $bindable(null) }: Props = $props();

  const isClip = $derived(media ? media.kind === 'video' || isVideoPath(media.path) : false);
</script>

<figure>
  <div class="frame" class:empty={!media?.path}>
    {#if !media?.path}
      <p class="none">
        {media === undefined ? 'Loading the picture…' : `No picture yet: shot ${shotNumber} isn't made`}
      </p>
    {:else if isClip}
      <video
        bind:this={video}
        src={fileUrl(media.path)}
        preload="metadata"
        muted
        playsinline
        aria-label="Shot {shotNumber}"
        onloadedmetadata={(event) => {
          // rest on a frame inside the shot, not its first: a clip can open on the end of the scene before (d4fd shot 6)
          const clip = event.currentTarget;
          const start = media.from_sec ?? 0;
          clip.currentTime = start + Math.min(0.5, Math.max(0, (clip.duration - start) / 4));
        }}
      ></video>
    {:else}
      <img src={thumbUrl(media.path, LOOK_WIDTH)} alt="Shot {shotNumber}, look only" />
    {/if}
  </div>
  <figcaption>
    {#if media?.path && !isClip}Look only: this shot is not made as a video yet.{/if}
  </figcaption>
</figure>

<style>
  .frame {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--media);
  }
  .frame.empty {
    border-color: transparent;
    background: var(--ink-4);
  }
  video,
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .none {
    padding: var(--s-16);
    color: var(--muted);
    font-size: var(--t13);
    text-align: center;
  }
  figcaption {
    min-height: var(--s-24);
    margin-top: var(--s-4);
    color: var(--muted);
    font-size: var(--t12);
  }
</style>
