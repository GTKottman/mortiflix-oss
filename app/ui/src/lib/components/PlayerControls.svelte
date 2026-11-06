<!-- The player's control bar: play, frame step, time, seek (with markers), speed, loop, volume, captions, full screen.
     In a narrow player (under 720 px, e.g. Motion at 1366x768) the seek bar takes a full row of its own and the
     time, speed, loop and volume go on the row under it. -->
<script lang="ts">
  import { markerPercent, SPEEDS } from '../player/time';
  import { clock } from '../time';
  import type { PlayerMarker } from './VideoPlayer.svelte';

  interface Props {
    /** Seconds played and seconds in all. */
    time: number;
    total: number;
    paused: boolean;
    markers: readonly PlayerMarker[];
    fps: number;
    showFrame: boolean;
    hasCaptions: boolean;
    captionsOn: boolean;
    fullscreen: boolean;
    speed: number;
    loop: boolean;
    muted: boolean;
    volume: number;
    ontoggle: () => void;
    onstep: (direction: 1 | -1) => void;
    onseek: (seconds: number) => void;
    onmarker: (marker: PlayerMarker) => void;
    oncaptions: () => void;
    onfullscreen: () => void;
  }

  let {
    time,
    total,
    paused,
    markers,
    fps,
    showFrame,
    hasCaptions,
    captionsOn,
    fullscreen,
    speed = $bindable(),
    loop = $bindable(),
    muted = $bindable(),
    volume = $bindable(),
    ontoggle,
    onstep,
    onseek,
    onmarker,
    oncaptions,
    onfullscreen,
  }: Props = $props();

  const SEEK_STEPS = 1000;
  const played = $derived(total > 0 ? Math.round((time / total) * SEEK_STEPS) : 0);
</script>

<div class="controls">
  <div class="row">
    <button type="button" aria-label={paused ? 'Play' : 'Pause'} onclick={ontoggle}>
      {paused ? '▶' : '❚❚'}
    </button>
    <button type="button" aria-label="Back one frame" onclick={() => onstep(-1)}>◂|</button>
    <button type="button" aria-label="Forward one frame" onclick={() => onstep(1)}>|▸</button>
    <span class="time">{clock(time)}{showFrame ? ` · frame ${Math.round(time * fps)}` : ''}</span>
    <div class="seekbar">
      <input
        type="range"
        min="0"
        max={SEEK_STEPS}
        step="1"
        value={played}
        style:--p="{(played / SEEK_STEPS) * 100}%"
        aria-label="Seek"
        aria-valuetext="{clock(time)} of {clock(total)}"
        oninput={(event) => onseek((event.currentTarget.valueAsNumber / SEEK_STEPS) * total)}
      />
      {#each markers as marker (marker.id)}
        {@const left = markerPercent(marker.time, total)}
        <button
          type="button"
          class="marker {marker.tone ?? 'note'}"
          class:range={marker.end !== undefined}
          style:left="{left}%"
          style:width={marker.end !== undefined
            ? `${Math.max(markerPercent(marker.end, total) - left, 0.5)}%`
            : undefined}
          disabled={marker.tone === 'draft'}
          title="{marker.label} · {clock(marker.time)}{marker.end !== undefined
            ? ` – ${clock(marker.end)}`
            : ''}"
          aria-label="{marker.label}, at {clock(marker.time)}"
          onclick={() => onmarker(marker)}
        ></button>
      {/each}
    </div>
    <span class="time">{clock(total)}</span>
    <select aria-label="Speed" bind:value={speed}>
      {#each SPEEDS as option (option)}
        <option value={option}>{option}×</option>
      {/each}
    </select>
    <button
      type="button"
      aria-label="Loop"
      aria-pressed={loop}
      class:off={!loop}
      onclick={() => (loop = !loop)}
    >
      ⟲
    </button>
    <button
      type="button"
      aria-label={muted ? 'Unmute' : 'Mute'}
      onclick={() => {
        muted = !muted;
        if (!muted && volume === 0) volume = 1;
      }}
    >
      {muted ? 'Muted' : 'Vol'}
    </button>
    <input
      class="volume"
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={muted ? 0 : volume}
      style:--p="{(muted ? 0 : volume) * 100}%"
      aria-label="Volume"
      oninput={(event) => {
        volume = event.currentTarget.valueAsNumber;
        muted = volume === 0;
      }}
    />
    {#if hasCaptions}
      <button
        type="button"
        aria-label="Captions"
        aria-pressed={captionsOn}
        class:off={!captionsOn}
        onclick={oncaptions}
      >
        CC
      </button>
    {/if}
    <button
      type="button"
      aria-label={fullscreen ? 'Leave full screen' : 'Full screen'}
      onclick={onfullscreen}
    >
      ⛶
    </button>
  </div>
</div>

<style>
  .controls {
    position: absolute;
    inset: auto 0 0;
    container-type: inline-size;
    padding: var(--s-8) var(--s-12);
    background: linear-gradient(transparent, var(--scrim-strong));
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-8);
  }
  .controls select {
    appearance: none;
  }
  .controls button,
  .controls select {
    min-width: var(--h-sm);
    height: var(--h-sm);
    padding: 0 var(--s-8);
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--text);
    font: 600 var(--t13) / 1 var(--body);
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
  }
  .controls button:hover,
  .controls select:hover {
    background: var(--line);
  }
  .controls button.off {
    color: var(--faint);
  }
  .controls option {
    background: var(--ink-2);
  }
  .time {
    flex-shrink: 0;
    color: var(--text);
    font: 400 var(--t13) / 1 var(--mono);
    white-space: nowrap;
  }
  .seekbar {
    position: relative;
    display: flex;
    flex: 1;
    align-items: center;
    min-width: 0;
  }
  .seekbar input {
    width: 100%;
  }
  .marker {
    position: absolute;
    top: 0;
    bottom: 0;
    width: var(--s-8);
    padding: 0;
    transform: translateX(-50%);
  }
  .controls .marker::after {
    content: '';
    position: absolute;
    inset: var(--s-8) calc(50% - 1px);
    background: var(--tone);
  }
  .marker.range {
    min-width: var(--s-4);
    transform: none;
  }
  .controls .marker.range::after {
    inset: auto 0 var(--s-2);
    height: var(--s-4);
    opacity: 0.6;
  }
  .marker.note {
    --tone: var(--warn);
  }
  .marker.done {
    --tone: var(--good);
  }
  .marker.draft {
    --tone: var(--busy);
    cursor: default;
  }
  .marker.selected {
    --tone: var(--text);
  }
  input[type='range'] {
    height: var(--h-sm);
    appearance: none;
    background: none;
    cursor: pointer;
  }
  .volume {
    flex: 0 0 var(--volume-w);
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: var(--s-4);
    border-radius: var(--r-pill);
    background: linear-gradient(to right, var(--scrub) var(--p), var(--scrub-track) var(--p));
  }
  input[type='range']::-moz-range-track {
    height: var(--s-4);
    border-radius: var(--r-pill);
    background: linear-gradient(to right, var(--scrub) var(--p), var(--scrub-track) var(--p));
  }
  input[type='range']::-webkit-slider-thumb {
    width: var(--s-12);
    height: var(--s-12);
    margin-top: calc(var(--s-4) / 2 - var(--s-12) / 2);
    appearance: none;
    border: 0;
    border-radius: 50%;
    background: var(--scrub);
  }
  input[type='range']::-moz-range-thumb {
    width: var(--s-12);
    height: var(--s-12);
    border: 0;
    border-radius: 50%;
    background: var(--scrub);
  }
  /* A narrow player: the seek bar gets a row of its own, everything else goes on the row under it. */
  @container (max-width: 720px) {
    .row {
      flex-wrap: wrap;
      row-gap: 0;
    }
    .seekbar {
      flex: 1 0 100%;
      order: -1;
    }
    .row {
      column-gap: var(--s-8);
    }
    .volume {
      flex: 1 1 0;
      min-width: var(--s-24);
      max-width: var(--volume-w);
    }
  }
</style>
