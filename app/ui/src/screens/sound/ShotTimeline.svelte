<!-- The shot's clock: where the narration talks, and a bar for each sound where it lands and as long as its motion.
     One playhead. The scrub bar over both lanes moves it (mouse or arrow keys); a bar picks a sound and moves it there. -->
<script lang="ts">
  import { clockTenths } from '../../lib/time';
  import { isNew, markSpan, shotFraction } from './sound';
  import type { Cue, PlanShot } from './types';

  interface Props {
    shot: PlanShot;
    cues: Cue[];
    selectedId: string | undefined;
    /** The playhead, seconds into the shot. */
    offset: number;
    onseek: (offset: number) => void;
    onpick: (cue: Cue) => void;
  }

  let { shot, cues, selectedId, offset, onseek, onpick }: Props = $props();

  const span = $derived(Math.max(0.1, shot.to - shot.from));
  const percent = (time: number) => `${shotFraction(shot, time) * 100}%`;
</script>

<div class="lanes">
  <span class="label first">Voice</span>
  <div class="lane first" role="img" aria-label="Where the voice talks">
    {#each shot.talk as [start, end], index (index)}
      {#if end >= shot.from && start <= shot.to}
        <i
          class="talk"
          style:left={percent(start)}
          style:width="{(Math.max(0.02, end - start) / span) * 100}%"
        ></i>
      {/if}
    {/each}
  </div>
  <span class="label second">Sound effects</span>
  <div class="lane second">
    {#each cues as cue, index (cue.id)}
      {@const place = markSpan(shot, cues, index)}
      <button
        type="button"
        class="mark"
        class:new={isNew(cue)}
        class:selected={cue.id === selectedId}
        class:cut={cue.status === 'cut'}
        style:left="{place.left}%"
        style:width="{place.width}%"
        title="{clockTenths(cue.at_sec)} {cue.what}"
        aria-label="{clockTenths(cue.at_sec)} {cue.what}"
        onclick={() => onpick(cue)}
      ></button>
    {/each}
  </div>
  <div class="head" style:--at={shotFraction(shot, shot.from + offset)}>
    <input
      class="scrub"
      type="range"
      min="0"
      max={span}
      step="0.05"
      value={offset}
      aria-label="Playhead in this shot"
      aria-valuetext={clockTenths(shot.from + offset)}
      oninput={(event) => onseek(event.currentTarget.valueAsNumber)}
    />
    <i class="line"></i>
  </div>
</div>
<div class="axis"><span>{clockTenths(shot.from)}</span><span>{clockTenths(shot.to)}</span></div>
<div class="key">
  <span><i class="swatch"></i>From your library</span>
  <span><i class="swatch new"></i>New (costs credits)</span>
  <span>Each bar is as long as its motion</span>
</div>

<style>
  .lanes {
    display: grid;
    grid-template-columns: var(--shot-label-w) minmax(0, 1fr);
    align-items: center;
    gap: var(--s-8) var(--s-12);
  }
  .label {
    grid-column: 1;
    color: var(--muted);
    font-size: var(--t12);
    white-space: nowrap;
  }
  .first {
    grid-row: 1;
  }
  .second {
    grid-row: 2;
  }
  .lane {
    position: relative;
    grid-column: 2;
    height: var(--shot-lane-h);
    overflow: hidden;
    border-radius: var(--r-sm);
    background: var(--ink-2);
  }
  .talk {
    position: absolute;
    top: var(--shot-talk-inset);
    bottom: var(--shot-talk-inset);
    min-width: 2px;
    border-radius: var(--r-xs);
    background: var(--faint);
    opacity: 0.7;
  }
  .head {
    position: relative;
    grid-column: 2;
    grid-row: 1 / 3;
  }
  .scrub {
    position: absolute;
    inset: 0;
    z-index: 1;
    width: 100%;
    height: 100%;
    margin: 0;
    appearance: none;
    background: none;
    opacity: 0;
    cursor: pointer;
  }
  .scrub:focus-visible {
    opacity: 1;
    outline: var(--focus);
    outline-offset: var(--focus-off);
  }
  .scrub::-webkit-slider-runnable-track {
    background: none;
  }
  .scrub::-webkit-slider-thumb {
    appearance: none;
    width: 0;
    height: 0;
  }
  .line {
    position: absolute;
    top: calc(var(--s-2) * -1);
    bottom: calc(var(--s-2) * -1);
    left: calc(var(--at, 0) * 100%);
    width: 2px;
    background: var(--text);
    pointer-events: none;
  }
  .mark {
    position: absolute;
    z-index: 2;
    top: var(--s-8);
    bottom: var(--s-8);
    min-width: 3px;
    padding: 0;
    border: 0;
    border-radius: var(--r-xs);
    background: var(--text);
    cursor: pointer;
  }
  .mark::after {
    content: '';
    position: absolute;
    inset: calc(var(--s-8) * -1) calc(var(--s-8) * -1);
  }
  .mark.new {
    border: 2px solid var(--busy);
    background: transparent;
  }
  .mark.selected {
    outline: var(--focus);
    outline-offset: 3px;
  }
  .mark.cut {
    opacity: 0.3;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    margin-left: calc(var(--shot-label-w) + var(--s-12));
    color: var(--faint);
    font: 400 var(--t12) / 1.5 var(--mono);
  }
  .key {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-16);
    color: var(--muted);
    font-size: var(--t12);
  }
  .key span {
    display: inline-flex;
    flex-shrink: 0;
    white-space: nowrap;
    align-items: center;
    gap: var(--s-8);
  }
  .swatch {
    width: var(--s-12);
    height: var(--s-12);
    border-radius: var(--r-xs);
    background: var(--text);
  }
  .swatch.new {
    border: 2px solid var(--busy);
    background: transparent;
  }
</style>
