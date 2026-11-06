<!-- The clip as a strip of its own frames, as on the tablet: numbered note pins above it, drag it to scrub, a playhead,
     the frame under the playhead bright and the rest dimmed. -->
<script lang="ts">
  import type { PlayerMarker } from '../../lib/components/VideoPlayer.svelte';
  import { markerPercent } from '../../lib/player/time';
  import { clipStrip } from './media';
  import { clock } from './scenes';

  interface Props {
    src: string;
    now: number;
    length: number;
    fps: number;
    /** The clip stands up: more, narrower frames. */
    tall: boolean;
    pins: readonly PlayerMarker[];
    onseek: (seconds: number) => void;
    onpin: (pin: PlayerMarker) => void;
  }

  let { src, now, length, fps, tall, pins, onseek, onpin }: Props = $props();

  let frames = $state<string[]>([]);
  const count = $derived(tall ? 16 : 8);
  const head = $derived(markerPercent(now, length));
  const under = $derived(Math.min(count - 1, Math.floor((head / 100) * count)));

  $effect(() => {
    const stop = new AbortController();
    frames = [];
    void clipStrip(src, count, stop.signal, (list) => (frames = list));
    return () => stop.abort();
  });

  function scrub(event: PointerEvent, strip: HTMLElement) {
    const box = strip.getBoundingClientRect();
    onseek((Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width) * length);
  }

  function down(event: PointerEvent) {
    const strip = event.currentTarget as HTMLElement;
    strip.setPointerCapture(event.pointerId);
    scrub(event, strip);
  }

  function move(event: PointerEvent) {
    const strip = event.currentTarget as HTMLElement;
    if (strip.hasPointerCapture(event.pointerId)) scrub(event, strip);
  }

  function onkeydown(event: KeyboardEvent) {
    const step = { ArrowLeft: -1 / fps, ArrowRight: 1 / fps }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    onseek(now + step);
  }
</script>

<div class="film">
  <div class="pins">
    {#each pins as pin, index (pin.id)}
      {@const left = markerPercent(pin.time, length)}
      {#if pin.end !== undefined}
        <span
          class="span {pin.tone ?? 'note'}"
          style:left="{left}%"
          style:width="{Math.max(markerPercent(pin.end, length) - left, 0.5)}%"
        ></span>
      {/if}
      <button
        type="button"
        class="pin {pin.tone ?? 'note'}"
        style:left="{left}%"
        disabled={pin.tone === 'draft'}
        title="{pin.label} · {clock(pin.time)}"
        aria-label="{pin.label} {index + 1}, at {clock(pin.time)}"
        onclick={() => onpin(pin)}>{pin.tone === 'draft' ? '•' : index + 1}</button
      >
    {/each}
  </div>
  <div
    class="strip"
    role="slider"
    tabindex="0"
    aria-label="Position in the scene"
    aria-valuemin={0}
    aria-valuemax={Math.round(length * fps)}
    aria-valuenow={Math.round(now * fps)}
    aria-valuetext={clock(now)}
    onpointerdown={down}
    onpointermove={move}
    {onkeydown}
  >
    {#each Array.from({ length: count }, (_, index) => index) as index (index)}
      <span class="cell" class:here={index === under}>
        {#if frames[index]}<img src={frames[index]} alt="" draggable="false" />{/if}
      </span>
    {/each}
    <i class="head" style:left="{head}%"></i>
  </div>
</div>

<style>
  .film {
    display: grid;
    gap: var(--s-4);
    min-width: 0;
  }
  .pins {
    position: relative;
    height: var(--motion-pin);
    /* the first and last pin stay inside the row */
    margin: 0 calc(var(--motion-pin) / 2);
  }
  .pin {
    position: absolute;
    top: 0;
    display: grid;
    place-items: center;
    width: var(--motion-pin);
    height: var(--motion-pin);
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--bad);
    color: var(--on-grad);
    font: 800 var(--t12) / 1 var(--body);
    transform: translateX(-50%);
    cursor: pointer;
  }
  .pin.done {
    background: var(--ink-4);
    color: var(--muted);
  }
  .pin.selected {
    box-shadow: 0 0 0 2px var(--text);
  }
  .pin.draft {
    background: var(--warn);
    cursor: default;
  }
  .span {
    position: absolute;
    bottom: 0;
    height: 3px;
    border-radius: 2px;
    background: var(--bad);
  }
  .span.done {
    background: var(--ink-4);
  }
  .span.draft {
    background: var(--warn);
  }
  .strip {
    position: relative;
    display: flex;
    gap: 2px;
    height: var(--motion-strip-h);
    overflow: hidden;
    border-radius: var(--r-sm);
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
  }
  .cell {
    flex: 1 1 0;
    min-width: 0;
    background: var(--ink-3);
    opacity: 0.55;
  }
  .cell.here {
    opacity: 1;
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
  }
  .head {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 3px;
    margin-left: -1px;
    border-radius: 2px;
    background: var(--warn);
    pointer-events: none;
  }
</style>
