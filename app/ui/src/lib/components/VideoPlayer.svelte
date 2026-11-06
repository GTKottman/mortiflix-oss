<!-- The one video player: a real 16:9 frame with a poster, a big play button, controls that are always visible
     (play, frame step, time, seek, speed, loop, volume, captions when the file has them, full screen) and its own
     loading, "won't play" and "file missing" states. Finish plays the final video with it; Motion plays scenes.
     Keys with the player focused: Space or K play, , and . step one frame, arrows jump 5 s, F full screen, M mute.
     Nothing to play yet (no `src`): the `empty` snippet fills the frame, over the poster if there is one. -->
<script lang="ts" module>
  /** A point on the timeline the owner can jump to (a scene start, a note). */
  export interface PlayerMarker {
    id: string;
    /** Seconds from the start. */
    time: number;
    /** Read by screen readers and shown on hover, e.g. "Scene 3". */
    label: string;
    /** Seconds: makes the marker a stretch from `time` to `end`. */
    end?: number;
    /** Its colour: a note (default), a resolved one, the one picked, or one being written (not clickable). */
    tone?: MarkerTone;
  }

  export type MarkerTone = 'note' | 'done' | 'selected' | 'draft';

  /** What the file says about itself once it has loaded. */
  export interface VideoInfo {
    width: number;
    height: number;
    /** Seconds. */
    duration: number;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { clampTime, stepFrame } from '../player/time';
  import PlayerBigPlay from './PlayerBigPlay.svelte';
  import PlayerControls from './PlayerControls.svelte';
  import PlayerCover from './PlayerCover.svelte';
  import PlayerWontPlay from './PlayerWontPlay.svelte';

  interface Props {
    /** The video's address. Leave out while there is nothing to play. */
    src?: string;
    /** What the video is, e.g. "The final video". */
    label: string;
    /** A picture shown before play. */
    poster?: string;
    /** The length in seconds when it is known before the file loads. */
    duration?: number;
    /** Frames per second, for frame step. */
    fps?: number;
    /** Shows the frame number beside the time. */
    showFrame?: boolean;
    markers?: readonly PlayerMarker[];
    /** Offered next to Try again when the file is there but will not play. */
    download?: { href: string; name: string };
    /** The file is known to be gone. */
    missing?: boolean;
    /** The video restarts at the end. */
    loop?: boolean;
    /** Fills the frame while there is no `src`. */
    empty?: Snippet;
    /** A strip along the top of the picture, e.g. "Earlier version". */
    banner?: Snippet;
    /** Only the picture: the screen puts its own controls under it, so nothing sits on the video. */
    bare?: boolean;
    onmetadata?: (info: VideoInfo) => void;
    /** A marker was used to jump. */
    onmarker?: (marker: PlayerMarker) => void;
    /** The server answered 404 for the file: it was deleted after it was made. */
    onmissing?: () => void;
  }

  type Status = 'loading' | 'ready' | 'wont-play' | 'missing';

  let {
    src,
    label,
    poster,
    duration: knownDuration,
    fps = 30,
    showFrame = false,
    markers = [],
    download,
    missing = false,
    loop = $bindable(false),
    empty,
    banner,
    bare = false,
    onmetadata,
    onmarker,
    onmissing,
  }: Props = $props();

  let frame = $state<HTMLDivElement>();
  let video = $state<HTMLVideoElement>();
  let status = $state<Status>('loading');
  let attempt = $state(0);
  let time = $state(0);
  let length = $state(0);
  let paused = $state(true);
  let buffering = $state(false);
  let volume = $state(1);
  let muted = $state(false);
  let speed = $state(1);
  let fullscreen = $state(false);
  let hasCaptions = $state(false);
  let captionsOn = $state(false);

  const total = $derived(length || knownDuration || 0);
  const address = $derived(src ? (attempt ? `${src}${src.includes('?') ? '&' : '?'}r=${attempt}` : src) : '');
  const playable = $derived(Boolean(src) && !missing && status !== 'missing');

  // A new file starts from the beginning.
  $effect(() => {
    void src;
    status = 'loading';
    time = 0;
    length = 0;
    hasCaptions = false;
    captionsOn = false;
  });

  /** Jumps to a time in seconds. */
  export function seek(seconds: number): void {
    if (video) time = clampTime(seconds, total);
  }

  function toggle() {
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }

  function step(direction: 1 | -1) {
    video?.pause();
    seek(stepFrame(time, direction, fps, total));
  }

  function loaded() {
    if (!video) return;
    length = video.duration;
    status = 'ready';
    onmetadata?.({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
    const track = video.textTracks[0];
    if (track) {
      track.mode = 'disabled';
      hasCaptions = true;
    }
  }

  async function failed() {
    // 404 = deleted after it was made; anything else = the file is there but would not open.
    const asked = address;
    const gone = await fetch(asked, { method: 'HEAD' }).then(
      (reply) => reply.status === 404,
      () => false,
    );
    // The player moved on to another file (or a retry) meanwhile: this answer is about the old one.
    if (asked !== address) return;
    status = gone ? 'missing' : 'wont-play';
    if (gone) onmissing?.();
  }

  function toggleCaptions() {
    const track = video?.textTracks[0];
    if (!track) return;
    captionsOn = !captionsOn;
    track.mode = captionsOn ? 'showing' : 'disabled';
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame?.requestFullscreen?.();
  }

  function jump(marker: PlayerMarker) {
    seek(marker.time);
    onmarker?.(marker);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.target !== frame || status !== 'ready') return;
    const keys: Record<string, () => void> = {
      ' ': toggle,
      k: toggle,
      ',': () => step(-1),
      '.': () => step(1),
      ArrowLeft: () => seek(time - 5),
      ArrowRight: () => seek(time + 5),
      f: toggleFullscreen,
      m: () => (muted = !muted),
    };
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  }
</script>

<svelte:document onfullscreenchange={() => (fullscreen = document.fullscreenElement === frame)} />

<!-- The frame is one custom widget with its own keys (listed at the top). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={frame}
  class="player"
  class:empty={!playable}
  role="group"
  aria-label={label}
  tabindex={status === 'ready' ? 0 : -1}
  {onkeydown}
>
  {#if playable}
    {#key attempt}
      <!-- The final video's captions are burned in; a caption track exists only when the file has one. -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={video}
        bind:currentTime={time}
        bind:paused
        bind:volume
        bind:muted
        bind:playbackRate={speed}
        {loop}
        src={address}
        {poster}
        preload="metadata"
        playsinline
        tabindex="-1"
        aria-label={label}
        onloadedmetadata={loaded}
        onerror={failed}
        onwaiting={() => (buffering = true)}
        onplaying={() => (buffering = false)}
        onclick={toggle}
      ></video>
    {/key}
    {#if banner}<div class="banner">{@render banner()}</div>{/if}
    {#if status === 'loading'}
      <PlayerCover light role="status" title="Loading the video…" />
    {:else if status === 'wont-play'}
      <PlayerWontPlay
        {download}
        onretry={() => {
          status = 'loading';
          attempt++;
        }}
      />
    {:else if buffering && !paused}
      <PlayerCover light role="status" title="Loading…" />
    {:else if paused && !bare}
      <PlayerCover light><PlayerBigPlay {label} onplay={toggle} /></PlayerCover>
    {/if}
    <!-- Shown while loading too, so the controls are always in the Tab order (a background tab may never load). -->
    {#if !bare && (status === 'ready' || status === 'loading')}
      <PlayerControls
        {time}
        {total}
        {paused}
        {markers}
        {fps}
        {showFrame}
        {hasCaptions}
        {captionsOn}
        {fullscreen}
        bind:speed
        bind:loop
        bind:muted
        bind:volume
        ontoggle={toggle}
        onstep={step}
        onseek={seek}
        onmarker={jump}
        oncaptions={toggleCaptions}
        onfullscreen={toggleFullscreen}
      />
    {/if}
  {:else}
    {#if poster}<img class="poster" src={poster} alt="" />{/if}
    {#if missing || status === 'missing'}
      <PlayerCover
        role="alert"
        title="File missing"
        detail="The video file is no longer in the studio folder."
      />
    {:else if empty}
      {@render empty()}
    {:else}
      <PlayerCover title="Nothing to play yet" />
    {/if}
  {/if}
</div>

<style>
  .player {
    position: relative;
    width: 100%;
    aspect-ratio: var(--player-aspect, 16 / 9);
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--media);
  }
  .player.empty {
    background: var(--ink-3);
  }
  video,
  .poster {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: var(--media);
  }
  .banner {
    position: absolute;
    inset: 0 0 auto;
    padding: var(--s-8) var(--s-12);
    background: var(--scrim-strong);
    color: var(--muted);
    font-size: var(--t14);
  }
</style>
