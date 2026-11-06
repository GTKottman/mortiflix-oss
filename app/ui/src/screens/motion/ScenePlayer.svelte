<!-- The scene's clip, laid out like the tablet's player: the picture as big as fits at the clip's own shape, the
     controls under it, then the note pins and the filmstrip. A scene with no clip yet says why in the picture's
     place (SceneCover). The screen reads the playhead and moves it through the PlayerHandle on the session. -->
<script lang="ts">
  import VideoPlayer, { type PlayerMarker, type VideoInfo } from '../../lib/components/VideoPlayer.svelte';
  import { plural } from '../../lib/words';
  import { clipUrl, pictureUrl } from './media';
  import Elapsed from '../../lib/components/Elapsed.svelte';
  import { useMotion } from './motion.svelte';
  import FilmStrip from './FilmStrip.svelte';
  import ReviewControls from './ReviewControls.svelte';
  import { etaText, noteSeconds, noteVersion, sceneLength } from './scenes';
  import SceneCover from './SceneCover.svelte';

  const motion = useMotion();

  let frame = $state<HTMLDivElement>();
  let player = $state<ReturnType<typeof VideoPlayer>>();
  let shape = $state(16 / 9);
  let now = $state(0);
  let paused = $state(true);
  let muted = $state(false);
  let loop = $state(false);
  let speed = $state(1);

  const media = $derived(motion.media);
  const scene = $derived(motion.scene);
  const src = $derived(media.video && media.path ? clipUrl(media.path) : undefined);
  const poster = $derived(!media.video && media.path ? pictureUrl(media.path, 1280) : undefined);
  const shownVersion = $derived(motion.viewed?.n ?? motion.latest);
  const since = $derived(scene ? motion.makingSince[scene.beat] : undefined);
  const remaking = $derived(scene?.state === 'making' && media.video);
  const comparing = $derived(motion.compare && motion.viewed !== null);
  const markers = $derived.by<PlayerMarker[]>(() => {
    const list: PlayerMarker[] = motion.sceneNotes
      .filter((note) => note.kind !== 'scene' && noteVersion(note, motion.latest) === shownVersion)
      .map((note): PlayerMarker => ({
        id: note.id,
        time: note.time_end !== undefined ? (note.time ?? 0) : noteSeconds(note, motion.fps),
        ...(note.time_end !== undefined ? { end: note.time_end } : {}),
        tone: motion.selected === note.id ? 'selected' : note.resolved ? 'done' : 'note',
        label: note.time_end !== undefined ? 'Note on a stretch' : 'Note',
      }))
      .sort((a, b) => a.time - b.time);
    const { draft } = motion;
    if (draft.mode === 'range' && draft.locked) {
      list.push({
        id: 'draft',
        time: draft.time,
        end: draft.timeEnd ?? Math.max(motion.time, draft.time + 0.1),
        tone: 'draft',
        label: 'Note being written',
      });
    }
    return list;
  });

  const length = $derived(motion.duration || sceneLength(motion.shots) || 0);

  const video = (): HTMLVideoElement | null => frame?.querySelector('video') ?? null;

  // The playhead moves every frame while playing; timeupdate alone comes four times a second.
  $effect(() => {
    if (paused) return;
    let turn = requestAnimationFrame(function follow() {
      now = video()?.currentTime ?? now;
      turn = requestAnimationFrame(follow);
    });
    return () => cancelAnimationFrame(turn);
  });

  $effect(() => {
    const element = video();
    if (!element) return;
    element.muted = muted;
    element.loop = loop;
    element.playbackRate = speed;
  });

  function fullscreen() {
    void frame?.querySelector('.player')?.requestFullscreen?.();
  }

  function scrub(seconds: number) {
    motion.player?.pause();
    motion.player?.seek(seconds);
    now = seconds;
  }

  $effect(() => {
    motion.player = {
      now: () => video()?.currentTime ?? 0,
      paused: () => video()?.paused ?? true,
      seek: (seconds) => player?.seek(seconds),
      pause: () => video()?.pause(),
      togglePlay: () => {
        const element = video();
        if (element?.paused) void element.play().catch(() => undefined);
        else element?.pause();
      },
      step: (direction) => {
        const element = video();
        element?.pause();
        player?.seek((element?.currentTime ?? 0) + direction / motion.fps);
      },
    };
    return () => (motion.player = null);
  });

  // A scene without a video has nothing loading or failing.
  $effect(() => {
    if (!src) motion.setClip('idle');
  });

  function onMetadata(info: VideoInfo) {
    motion.duration = info.duration;
    if (info.width && info.height) shape = info.width / info.height;
  }

  function onLoaded(event: Event) {
    if (!(event.target instanceof HTMLVideoElement)) return;
    motion.setClip('ready');
    const resume = motion.takeResume();
    if (!resume) return;
    player?.seek(resume.time);
    if (!resume.paused) void event.target.play().catch(() => undefined);
  }

  function onFailed(event: Event) {
    if (event.target instanceof HTMLVideoElement) {
      motion.setClip('error', event.target.error?.message || 'The file may be missing or not finished.');
    }
  }

  function jump(marker: PlayerMarker) {
    const note = motion.sceneNotes.find((entry) => entry.id === marker.id);
    if (note) motion.pickNote(note);
  }
</script>

{#snippet strip()}
  {#if remaking && motion.waiting}
    <b>{motion.waiting.title}.</b> {motion.waiting.body} You are watching Version {shownVersion}.
  {:else if remaking && motion.work?.here}
    <b class="busy"
      >◌ Regenerating Version {motion.latest + 1} from your notes{etaText(scene)}{#if since !== undefined}
        · <Elapsed {since} /> so far{/if}</b
    >
    You are watching Version {shownVersion}. The new version replaces it here when it is ready.
  {:else if motion.viewed}
    {motion.side === 'before' ? 'Before' : 'After'} · Version {motion.viewed.n}
  {/if}
{/snippet}

<!-- The media events do not bubble, so they are caught on the way down to the player's video. -->
<div
  bind:this={frame}
  class="screen"
  style:--player-aspect={shape}
  role="group"
  aria-label={scene ? `Scene ${motion.index + 1}: ${scene.name}` : 'Scene'}
  ontimeupdatecapture={(event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    now = event.target.currentTime;
    motion.setTime(now);
  }}
  onplaycapture={() => (paused = false)}
  onpausecapture={() => (paused = true)}
  onloadstartcapture={(event) => event.target instanceof HTMLVideoElement && motion.setClip('loading')}
  onloadeddatacapture={onLoaded}
  onerrorcapture={onFailed}
>
  <VideoPlayer
    bind:this={player}
    {src}
    {poster}
    label={scene ? `Scene ${motion.index + 1} video` : 'Scene video'}
    duration={sceneLength(motion.shots)}
    fps={motion.fps}
    bare
    banner={remaking || comparing ? strip : undefined}
    onmetadata={onMetadata}
  >
    {#snippet empty()}<SceneCover />{/snippet}
  </VideoPlayer>
  {#if motion.clip === 'error' && motion.clipError}
    <p class="sr" role="status">{motion.clipError}</p>
  {/if}
  <span class="sr">{plural(markers.length, 'note')} on the timeline</span>
</div>
<ReviewControls
  {now}
  {length}
  {paused}
  playable={Boolean(src)}
  bind:muted
  bind:loop
  bind:speed
  onfullscreen={fullscreen}
/>
{#if src}
  <FilmStrip
    {src}
    {now}
    {length}
    fps={motion.fps}
    tall={shape < 1}
    pins={markers}
    onseek={scrub}
    onpin={jump}
  />
{/if}

<style>
  .screen {
    position: relative;
    /* as big as fits at the clip's own shape, leaving room for the controls and the strip */
    width: min(
      100%,
      calc(max(var(--motion-player-min-h), 100dvh - var(--motion-player-chrome-h)) * var(--player-aspect))
    );
    margin: 0 auto;
  }
  .busy {
    margin-right: var(--s-8);
    color: var(--busy);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
