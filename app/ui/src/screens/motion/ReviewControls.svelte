<!-- The row under the video, as on the tablet: the time and frame on the left, the transport in the middle, marking on
     the right. Mark this frame opens the Mark screen; Mark range is pressed at the start and again at the end. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { SPEEDS } from '../../lib/player/time';
  import MarkIcon from './MarkIcon.svelte';
  import { useMotion } from './motion.svelte';
  import { clock, clockWithFrame } from './scenes';

  interface Props {
    now: number;
    length: number;
    paused: boolean;
    /** The scene has a video to play (a still has only the marking). */
    playable: boolean;
    muted: boolean;
    loop: boolean;
    speed: number;
    onfullscreen: () => void;
  }

  let {
    now,
    length,
    paused,
    playable,
    muted = $bindable(),
    loop = $bindable(),
    speed = $bindable(),
    onfullscreen,
  }: Props = $props();

  const motion = useMotion();
  const draft = $derived(motion.draft);
  const off = $derived(!motion.canNote);
  const settingEnd = $derived(draft.mode === 'range' && draft.locked && draft.timeEnd === null);
</script>

<div class="row">
  <p class="time">
    {#if playable}<b>{clockWithFrame(now, motion.fps)}</b> / {clock(length)}{/if}
  </p>
  {#if playable}
    <div class="transport" role="group" aria-label="Playback">
      <button
        type="button"
        class="tool"
        aria-label={muted ? 'Sound on' : 'Sound off'}
        aria-pressed={muted}
        onclick={() => (muted = !muted)}><MarkIcon name={muted ? 'muted' : 'sound'} /></button
      >
      <button
        type="button"
        class="tool"
        aria-label="Loop"
        aria-pressed={loop}
        class:quiet={!loop}
        onclick={() => (loop = !loop)}><MarkIcon name="loop" /></button
      >
      <button type="button" class="tool" aria-label="Back one frame" onclick={() => motion.player?.step(-1)}
        ><MarkIcon name="previous" size={24} /></button
      >
      <button
        type="button"
        class="play"
        aria-label={paused ? 'Play' : 'Pause'}
        onclick={() => motion.player?.togglePlay()}
        ><MarkIcon name={paused ? 'play' : 'pause'} size={24} /></button
      >
      <button type="button" class="tool" aria-label="Forward one frame" onclick={() => motion.player?.step(1)}
        ><MarkIcon name="next" size={24} /></button
      >
      <select class="speed" aria-label="Speed" bind:value={speed}>
        {#each SPEEDS as option (option)}<option value={option}>{option}×</option>{/each}
      </select>
      <button type="button" class="tool" aria-label="Full screen" onclick={onfullscreen}
        ><MarkIcon name="fit" /></button
      >
    </div>
  {/if}
  <div class="marks">
    {#if settingEnd}
      <Button size="sm" variant="text" onclick={() => motion.cancelDraft()}>Cancel</Button>
    {/if}
    <Button
      disabled={off}
      pressed={settingEnd}
      title="Mark a stretch of time: press once at the start, again at the end"
      onclick={() => motion.markRange()}>{settingEnd ? 'Set range end' : 'Mark range'}</Button
    >
    <Button disabled={off} title="A note about the whole scene" onclick={() => motion.noteAboutScene()}
      >Scene note</Button
    >
    <Button
      variant="primary"
      disabled={off}
      title="Mark this exact frame (M)"
      onclick={() => motion.markFrame()}><MarkIcon name="mark" /> Mark this frame</Button
    >
  </div>
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: var(--s-12);
    --btn-flex: none;
  }
  .time {
    margin: 0;
    color: var(--faint);
    font: 400 var(--t13) / 1.3 var(--mono);
    white-space: nowrap;
  }
  .time b {
    color: var(--text);
    font-weight: 600;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: var(--s-4);
  }
  .marks {
    grid-column: 3;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--s-8);
  }
  .tool,
  .play {
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: var(--text);
    cursor: pointer;
  }
  .tool {
    width: var(--h-lg);
    height: var(--h-lg);
    background: none;
  }
  .tool:hover,
  .speed:hover {
    background: var(--ink-3);
  }
  .tool.quiet {
    color: var(--faint);
  }
  .play {
    width: var(--motion-play);
    height: var(--motion-play);
    margin: 0 var(--s-4);
    background: var(--ink-3);
  }
  .play:hover {
    background: var(--ink-4);
  }
  .speed {
    height: var(--h-lg);
    padding: 0 var(--s-8);
    border: 0;
    appearance: none;
    text-align: center;
    border-radius: var(--r-sm);
    background: none;
    color: var(--text);
    font: 600 var(--t12) / 1 var(--body);
  }
  /* a narrow column: time and transport on one line, the marking under them */
  @media (max-width: 1499px) {
    .row {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .transport {
      justify-self: end;
    }
    .marks {
      grid-column: 1 / -1;
    }
  }
</style>
