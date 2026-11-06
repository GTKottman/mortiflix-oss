<!-- Audio on a time line: a ruler, a playhead, one row (lane) per kind of audio and a clip for every piece, each as
     wide as it is long, with its waveform. Voice, Motion and Sound can all use it.

     Data comes in, choices go out: it owns no audio and no selection.
       lanes     rows from top to bottom; `kind` 'voice' = solid clips in their own colour, 'music' = hatched clips
       length    seconds the full width stands for (at zoom 1)
       markers   labels under the ruler, e.g. "Scene 2" at the second it starts
       time      the playhead, in seconds (bindable)
       selected  the id of the selected clip (a clip's id is unique across lanes)
       zoom      1 = fit the width; 2, 4, 8 = wider than the box, which then scrolls (the playhead stays in view)
       snap      a click on the ruler lands on the nearest clip edge within a few pixels
       onselect  a clip was clicked (or Enter / Space on it while it is not selected)
       onplay    a clip was double-clicked: play it
       onseek    the ruler was clicked: start from this second
       onclear   empty space was clicked: back to the overview -->
<script lang="ts" module>
  import type { Peaks } from '../audio/waveform';

  export type ClipState = 'ok' | 'review' | 'making' | 'none';

  export interface TimelineClip {
    id: string;
    from: number;
    to: number;
    /** Short name inside the clip, e.g. "2·3". */
    label: string;
    /** What it says or is, under the name; cut with … when the clip is narrow. */
    caption?: string;
    /** Clip colour (a CSS colour); music clips ignore it. */
    colour?: string;
    state: ClipState;
    /** A small word on the clip: Queued, Making, Failed. */
    badge?: { text: string; tone: 'queued' | 'busy' | 'bad' };
    /** Real peaks, once known. */
    peaks?: Peaks | null;
    /** Seconds this clip blends into the next one (drawn as a fade at its end). */
    fade?: number;
    /** Hover text. */
    title?: string;
    /** Read by screen readers: name and state. */
    description: string;
  }

  export interface TimelineLane {
    id: string;
    /** The word at the left of the row. */
    label: string;
    kind: 'voice' | 'music';
    clips: readonly TimelineClip[];
  }

  export interface TimelineMarker {
    at: number;
    label: string;
    /** The small square before the label. */
    colour?: string;
  }
</script>

<script lang="ts">
  import { clockTenths } from '../time';
  import { rulerStep, snapTime, SNAP_PIXELS } from '../audio/time';
  import TimelineClipBar from './TimelineClipBar.svelte';
  import TimelineRuler from './TimelineRuler.svelte';

  interface Props {
    lanes: readonly TimelineLane[];
    length: number;
    markers?: readonly TimelineMarker[];
    time?: number;
    selected?: string | null;
    zoom?: number;
    snap?: boolean;
    onselect?: (id: string) => void;
    onplay?: (id: string) => void;
    onseek?: (seconds: number) => void;
    onclear?: () => void;
  }

  let {
    lanes,
    length,
    markers = [],
    time = 0,
    selected = null,
    zoom = 1,
    snap = true,
    onselect,
    onplay,
    onseek,
    onclear,
  }: Props = $props();

  let scroller = $state<HTMLElement>();
  let inner = $state<HTMLElement>();
  let hover = $state<{ x: number; text: string } | null>(null);

  const total = $derived(Math.max(length, 1));
  const percent = (seconds: number) => `${((seconds / total) * 100).toFixed(3)}%`;
  const edges = $derived(lanes.flatMap((lane) => lane.clips.flatMap((clip) => [clip.from, clip.to])));

  function timeAt(event: MouseEvent): { seconds: number; width: number } | null {
    if (!inner) return null;
    const box = inner.getBoundingClientRect();
    const raw = ((event.clientX - box.left) / box.width) * total;
    const seconds = snap ? snapTime(raw, edges, (SNAP_PIXELS / box.width) * total) : raw;
    return { seconds, width: box.width };
  }

  function click(event: MouseEvent) {
    const target = event.target as Element;
    if (!target.closest('.ruler')) return onclear?.();
    const at = timeAt(event);
    if (at) onseek?.(at.seconds);
  }

  function move(event: MouseEvent) {
    const at = timeAt(event);
    if (!at) return;
    hover = { x: (at.seconds / total) * at.width, text: clockTenths(at.seconds) };
  }

  // Keep the playhead and the selected clip in view when zoomed in.
  $effect(() => {
    if (!scroller || zoom <= 1) return;
    const x = (time / total) * scroller.scrollWidth;
    if (x < scroller.scrollLeft + 20 || x > scroller.scrollLeft + scroller.clientWidth - 40) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * 0.3);
    }
  });

  $effect(() => {
    void zoom;
    if (!scroller || !selected) return;
    const node = scroller.querySelector<HTMLElement>(`[data-clip="${CSS.escape(selected)}"]`);
    if (!node) return;
    const start = node.offsetLeft;
    if (
      start < scroller.scrollLeft ||
      start + node.offsetWidth > scroller.scrollLeft + scroller.clientWidth
    ) {
      scroller.scrollLeft = Math.max(0, start - 40);
    }
  });
</script>

<div class="timeline">
  <div class="labels" aria-hidden="true">
    <span class="ruler-label"></span>
    {#each lanes as lane (lane.id)}<span class={lane.kind}>{lane.label}</span>{/each}
  </div>
  <div class="scroll" bind:this={scroller}>
    <!-- Clicks here only move the playhead or clear the selection; clips take focus and Enter / Space themselves. -->
    <div
      class="inner"
      role="presentation"
      bind:this={inner}
      style:width="{zoom * 100}%"
      onclick={click}
      onmousemove={move}
      onmouseleave={() => (hover = null)}
    >
      <TimelineRuler step={rulerStep(total)} {total} {markers} />
      {#each lanes as lane (lane.id)}
        <div class="lane {lane.kind}" role="group" aria-label={lane.label}>
          {#each lane.clips as clip (clip.id)}
            <TimelineClipBar
              {clip}
              kind={lane.kind}
              {total}
              selected={selected === clip.id}
              {onselect}
              {onplay}
            />
          {/each}
        </div>
      {/each}
      <span class="playhead" style:left={percent(time)}></span>
      {#if hover}
        <div class="hover" style:left="{hover.x}px"><span>{hover.text}</span></div>
      {/if}
    </div>
  </div>
</div>

<style>
  .timeline {
    --ruler-h: calc(var(--s-24) + var(--s-4));
    /* taller on tall screens, so the page is not all at the top (owner 2026-11-03: balance on the page) */
    --voice-h: clamp(calc(var(--s-64) + var(--s-24)), 15dvh, 11rem);
    --music-h: clamp(calc(var(--s-64) + var(--s-8)), 12dvh, 9rem);
    display: grid;
    grid-template-columns: calc(var(--s-48) + var(--s-8)) minmax(0, 1fr);
    gap: var(--s-8);
  }
  .labels,
  .inner {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .labels {
    color: var(--faint);
    font-size: var(--t13);
  }
  .labels span {
    display: flex;
    align-items: center;
    overflow: hidden;
    white-space: nowrap;
  }
  .ruler-label {
    height: var(--ruler-h);
  }
  .labels .voice,
  .lane.voice {
    height: var(--voice-h);
  }
  .labels .music,
  .lane.music {
    height: var(--music-h);
  }
  .scroll {
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--ink-4) transparent;
  }
  .inner {
    position: relative;
    min-width: 100%;
  }
  .lane {
    position: relative;
    flex: none;
    overflow: hidden;
    border-radius: var(--r);
    background: var(--ink-2);
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 3;
    width: 2px;
    border-radius: var(--r-xs);
    background: var(--text);
    pointer-events: none;
  }
  .hover {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 3;
    width: 0;
    border-left: 1px dashed var(--line-hover);
    pointer-events: none;
  }
  .hover span {
    position: absolute;
    top: var(--s-2);
    left: var(--s-4);
    padding: 1px var(--s-8);
    border-radius: var(--r-pill);
    background: var(--ink-3);
    font-size: var(--t12);
    white-space: nowrap;
  }
  @media (max-height: 800px) {
    .timeline {
      --ruler-h: var(--s-24);
      --voice-h: calc(var(--s-64) + var(--s-8));
      --music-h: calc(var(--s-48) + var(--s-12));
    }
  }
</style>
