<!-- One clip on an audio timeline: as wide as the piece is long, with its waveform, name, caption and state. -->
<script lang="ts">
  import { bucketCount } from '../audio/waveform';
  import type { ClipState, TimelineClip } from './AudioTimeline.svelte';
  import Waveform from './Waveform.svelte';

  interface Props {
    clip: TimelineClip;
    kind: 'voice' | 'music';
    /** Seconds the full width stands for. */
    total: number;
    selected: boolean;
    onselect?: (id: string) => void;
    onplay?: (id: string) => void;
  }

  const GLYPH: Record<ClipState, string> = { ok: '✓', review: '!', making: '◌', none: '○' };
  const FADE_MAX_PERCENT = 40;

  let { clip, kind, total, selected, onselect, onplay }: Props = $props();

  const percent = (seconds: number) => `${(total > 0 ? (seconds / total) * 100 : 0).toFixed(3)}%`;
  const length = $derived(clip.to - clip.from);

  // Keyboard = mouse: the first Enter / Space selects (a click), Enter on the selected clip plays it (the
  // double-click). Space on a selected clip is left to the screen's own Space = play shortcut.
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (selected && event.key === ' ') return;
    event.preventDefault();
    event.stopPropagation();
    if (selected) onplay?.(clip.id);
    else onselect?.(clip.id);
  }
</script>

<div
  class="clip {clip.state} {kind}"
  class:selected
  class:badged={clip.badge}
  role="button"
  tabindex="0"
  aria-pressed={selected}
  aria-label={clip.description}
  title={clip.title}
  data-clip={clip.id}
  data-glyph={GLYPH[clip.state]}
  style:left={percent(clip.from)}
  style:width={percent(length)}
  style:background={kind === 'voice' ? (clip.colour ?? 'var(--ink-4)') : undefined}
  onclick={(event) => {
    event.stopPropagation();
    onselect?.(clip.id);
  }}
  ondblclick={(event) => {
    event.stopPropagation();
    onplay?.(clip.id);
  }}
  {onkeydown}
>
  <span class="wave">
    <Waveform
      peaks={clip.peaks}
      seed={clip.id}
      count={bucketCount(length, kind === 'music')}
      music={kind === 'music'}
    />
  </span>
  <b>{clip.label}</b>
  {#if clip.badge}<span class="badge {clip.badge.tone}">{clip.badge.text}</span>{/if}
  {#if clip.caption}<span class="caption">{clip.caption}</span>{/if}
  {#if clip.fade}
    <i class="fade" style:width="{Math.min(FADE_MAX_PERCENT, (clip.fade / length) * 100)}%"></i>
  {/if}
</div>

<style>
  .clip {
    position: absolute;
    top: var(--s-4);
    bottom: var(--s-4);
    overflow: hidden;
    border-bottom: var(--clip-edge) solid transparent;
    border-radius: var(--r-sm);
    color: var(--on-grad);
    cursor: pointer;
    transition: filter var(--dur-fast) var(--ease);
  }
  .clip:hover {
    filter: brightness(1.12);
  }
  .music {
    background: repeating-linear-gradient(
      135deg,
      var(--ink-4) 0 var(--hatch),
      var(--ink-3) var(--hatch) calc(var(--hatch) * 2)
    );
    color: var(--text);
  }
  .music.none {
    opacity: 0.8;
  }
  .wave {
    position: absolute;
    inset: 0;
    color: color-mix(in srgb, var(--ink) 45%, transparent);
    pointer-events: none;
  }
  .music .wave {
    color: color-mix(in srgb, var(--text) 35%, transparent);
  }
  b {
    position: absolute;
    top: var(--s-4);
    left: var(--s-8);
    font: 600 var(--t12) / 1 var(--body);
    white-space: nowrap;
  }
  .caption {
    position: absolute;
    right: var(--s-24);
    bottom: var(--s-4);
    left: var(--s-8);
    overflow: hidden;
    font-size: var(--t12);
    line-height: 1.1;
    opacity: 0.85;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badged .caption {
    right: calc(var(--s-64) + var(--s-8));
  }
  .clip::after {
    content: attr(data-glyph);
    position: absolute;
    top: var(--s-2);
    right: var(--s-4);
    font: 700 var(--t13) / 1 var(--body);
  }
  .review {
    border-bottom-color: var(--warn);
    border-bottom-style: dashed;
  }
  .ok {
    border-bottom-color: var(--good);
  }
  .making {
    border-bottom-color: var(--busy);
  }
  .selected {
    z-index: 2;
    outline: var(--focus);
    outline-offset: 1px;
    box-shadow: 0 0 0 var(--clip-ring) var(--line);
  }
  .badge {
    position: absolute;
    right: var(--s-4);
    bottom: var(--s-4);
    padding: 1px var(--s-8);
    border: 1px solid var(--line-2);
    border-radius: var(--r-pill);
    background: var(--ink);
    color: var(--text);
    font: 600 var(--t12) / 1.2 var(--body);
    white-space: nowrap;
  }
  .badge.bad {
    border-color: var(--bad);
    color: var(--bad);
  }
  .badge.busy {
    border-color: var(--busy);
    color: var(--busy);
  }
  .badge.queued {
    border-color: var(--warn);
    color: var(--warn);
  }
  .fade {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--text) 28%, transparent));
  }
</style>
