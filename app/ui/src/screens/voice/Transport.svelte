<!-- Play, the time, the seek bar, Loop, ± 1 s, Snap, Volume and zoom. One row, always in the same place. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { clockTenths } from '../../lib/time';
  import type { VoiceModel } from './model.svelte';
  import PressedButton from './PressedButton.svelte';

  interface Props {
    model: VoiceModel;
  }

  let { model }: Props = $props();
  const player = $derived(model.player);
  const hasMix = $derived(Boolean(model.music.plan?.mix));
  /** The mix on file was made before a change to the voice or the music: it is played, and says so. */
  const mixStale = $derived(model.mixStale);
  const hasSelection = $derived(Boolean(model.selectedLine || model.selectedCue));
  const ZOOM_MAX = 8;
</script>

<div class="transport" role="group" aria-label="Playback">
  <Button
    size="sm"
    title={hasMix
      ? mixStale
        ? 'The last mix made. Changes since then are not in it: press Mix under the voice to hear them.'
        : 'The voice with the music ducked under it'
      : 'The voice only. Make the music mix to hear both.'}
    onclick={() => player.playAll()}
  >
    {player.active ? '■ Stop' : hasMix ? (mixStale ? '▶ Play mix (old)' : '▶ Play mix') : '▶ Play voice'}
  </Button>
  <Button
    size="sm"
    disabled={!hasSelection}
    title="Play the selected clip (Space, or double-click it)"
    onclick={() => model.playSelection()}
  >
    ▶ Selection
  </Button>
  <span class="time"><b>{clockTenths(player.time)}</b> / {clockTenths(model.length)}</span>
  <input
    class="seek"
    type="range"
    min="0"
    max={model.length}
    step="0.1"
    value={player.time}
    aria-label="Seek"
    onchange={(event) => player.seek(Number(event.currentTarget.value))}
  />
  <PressedButton
    pressed={player.loop}
    title="Repeat the selected line"
    onclick={() => (player.loop = !player.loop)}>Loop</PressedButton
  >
  <PressedButton
    pressed={player.roll}
    title="When looping, add a second of the line before and the line after"
    onclick={() => (player.roll = !player.roll)}>± 1 s</PressedButton
  >
  <PressedButton
    pressed={model.snap}
    title="Snap the playhead to clip and scene edges"
    onclick={() => (model.snap = !model.snap)}>Snap</PressedButton
  >
  <label class="volume">
    Volume
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={player.volume}
      aria-label="Volume"
      oninput={(event) => player.setVolume(Number(event.currentTarget.value))}
    />
  </label>
  <span class="zoom" role="group" aria-label="Zoom">
    <Button
      size="sm"
      variant="text"
      aria-label="Zoom out"
      disabled={model.zoom <= 1}
      onclick={() => (model.zoom /= 2)}>−</Button
    >
    <Button size="sm" variant="text" disabled={model.zoom === 1} onclick={() => (model.zoom = 1)}>Fit</Button>
    <Button
      size="sm"
      variant="text"
      aria-label="Zoom in"
      disabled={model.zoom >= ZOOM_MAX}
      onclick={() => (model.zoom *= 2)}>+</Button
    >
  </span>
</div>

<style>
  .transport {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-12);
    min-height: var(--h);
    padding: var(--s-12) 0 0;
    border-top: 1px solid var(--line);
  }
  .time {
    color: var(--muted);
    font-size: var(--t13);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .time b {
    color: var(--text);
    font-weight: 500;
  }
  input[type='range'] {
    height: var(--s-4);
    border-radius: var(--s-4);
    background: var(--ink-4);
    appearance: none;
  }
  input[type='range']::-webkit-slider-thumb {
    width: var(--knob);
    height: var(--knob);
    border: 0;
    border-radius: 50%;
    background: var(--text);
    appearance: none;
  }
  .seek {
    flex: 1;
    min-width: calc(var(--s-64) + var(--s-16));
  }
  .volume {
    display: inline-flex;
    align-items: center;
    gap: var(--s-8);
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .volume input {
    width: calc(var(--s-64) + var(--s-16));
  }
  .zoom {
    display: inline-flex;
    flex-shrink: 0;
    gap: var(--s-4);
  }
</style>
