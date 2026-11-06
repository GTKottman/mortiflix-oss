<!-- The voice and the music along time, as clips: a clip per line (colour = scene) and per music cue.
     The same pixels whatever is selected. Plain data for AudioTimeline; the key under it. -->
<script lang="ts">
  import AudioTimeline, {
    type ClipState,
    type TimelineClip,
  } from '../../lib/components/AudioTimeline.svelte';
  import { clockTenths } from '../../lib/time';
  import { cueName, cueNumber } from './review';
  import type { VoiceModel } from './model.svelte';
  import type { CueState, MusicCue, VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
  }

  let { model }: Props = $props();

  const LINE_STATE_WORD: Record<ClipState, string> = {
    ok: 'approved',
    review: 'to review',
    making: 'being made',
    none: 'not made',
  };
  const CUE_STATE: Record<CueState, ClipState> = {
    ok: 'ok',
    planned: 'none',
    stale: 'review',
    made: 'review',
  };

  function badgeFor(id: string, making: boolean): TimelineClip['badge'] {
    if (model.basket.failed.has(id)) return { text: 'Failed', tone: 'bad' };
    if (model.basket.makingId === id || making) return { text: 'Making', tone: 'busy' };
    if (model.basket.lines.has(id) || model.basket.cues.has(id)) return { text: 'Queued', tone: 'queued' };
    return undefined;
  }

  function lineClip(line: VoiceLine, place: number): TimelineClip {
    const state: ClipState = model.isMaking(line) ? 'making' : model.needsYou(line) ? 'review' : 'ok';
    const name = model.nameOf(line.node);
    return {
      id: line.node,
      from: line.start_sec,
      to: line.start_sec + line.dur_sec,
      label: `${line.beat_no}·${place}`,
      caption:
        model
          .textOf(line)
          .replace(/\[[^\]]*\]/g, '')
          .trim() + noWave(line.path),
      colour: line.colour?.chip,
      state,
      badge: badgeFor(line.node, model.isSent(line.node)),
      peaks: model.peaks.get(line.path ?? ''),
      title: `${name} · ${clockTenths(line.start_sec)} · ${line.dur_sec.toFixed(1)} s\n${model.textOf(line)}`,
      description: `${name}, ${LINE_STATE_WORD[state]}`,
    };
  }

  /** Peaks that could not be read are drawn flat (model.noWave): say so, the shape is not the sound. */
  const noWave = (path: string | null | undefined): string =>
    path && model.noWave.has(path) ? ' · no waveform' : '';

  function cueClip(cue: MusicCue): TimelineClip {
    const state = CUE_STATE[cue.state];
    return {
      id: cue.id,
      from: cue.from_sec,
      to: cue.to_sec,
      label: cueName(cue.id),
      caption: (cue.mood ?? '') + noWave(cue.path),
      state,
      badge: badgeFor(cue.id, false),
      peaks: model.peaks.get(cue.path ?? ''),
      fade: cue.crossfade_sec,
      title: `${cueName(cue.id)} · ${cue.mood ?? ''} · ${clockTenths(cue.from_sec)}–${clockTenths(cue.to_sec)} · ducks ${Math.abs(cue.duck_db ?? 0)} dB under words`,
      description: `Music ${cueNumber(cue.id)}: ${cue.mood ?? ''}, ${LINE_STATE_WORD[state]}`,
    };
  }

  const lanes = $derived.by(() => {
    const placeInScene: Record<string, number> = {};
    const voice = model.lines.map((line) => {
      const place = (placeInScene[line.beat] ?? 0) + 1;
      placeInScene[line.beat] = place;
      return lineClip(line, place);
    });
    const music = model.music.cues
      .filter((cue) => Number.isFinite(cue.from_sec) && Number.isFinite(cue.to_sec))
      .map(cueClip);
    return [
      { id: 'voice', label: 'Voice', kind: 'voice' as const, clips: voice },
      { id: 'music', label: 'Music', kind: 'music' as const, clips: music },
    ];
  });

  const markers = $derived(
    model.scenes.map((scene) => ({ at: scene.start, label: `${scene.no}`, colour: scene.chip })),
  );

  $effect(() => {
    for (const line of model.lines) model.ensurePeaks(line.path, line.dur_sec, false);
    for (const cue of model.music.cues) model.ensurePeaks(cue.path, cue.to_sec - cue.from_sec, true);
  });

  function select(id: string) {
    if (model.lineById(id)) model.select(id);
    else model.selectCue(id);
  }

  function play(id: string) {
    select(id);
    model.playSelection();
  }
</script>

<div class="stack">
  <AudioTimeline
    {lanes}
    {markers}
    length={model.length}
    time={model.player.time}
    selected={model.selectedLine ?? model.selectedCue}
    zoom={model.zoom}
    snap={model.snap}
    onselect={select}
    onplay={play}
    onseek={(seconds) => model.player.seek(seconds)}
    onclear={() => model.deselect()}
  />
  <p class="key">
    <span>Colour = scene</span>
    <span class="ok">✓ approved</span>
    <span class="review">! to review</span>
    <span class="none">○ not made</span>
    <span>Making · Queued · Failed = what the queue is doing</span>
    <span class="keys">
      Click a clip · double-click plays it · <kbd>◂</kbd><kbd>▸</kbd> move · <kbd>Space</kbd> play ·
      <kbd>Enter</kbd> approve · <kbd>F</kbd> fix · <kbd>Esc</kbd> deselect
    </span>
  </p>
</div>

<style>
  .stack {
    display: grid;
    gap: var(--s-8);
  }
  .key {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: var(--s-4) var(--s-24);
    padding-top: var(--s-4);
    color: var(--muted);
    font-size: var(--t13);
  }
  .key > span:not(.keys) {
    white-space: nowrap;
  }
  .ok {
    color: var(--good);
  }
  .review,
  .none {
    color: var(--warn);
  }
  .keys {
    flex-basis: 100%;
    text-align: center;
    color: var(--faint);
  }
  kbd {
    margin: 0 var(--s-2);
    padding: 0 var(--s-4);
    border: 1px solid var(--line-2);
    border-radius: var(--s-4);
    background: var(--ink-3);
    color: var(--muted);
    font: var(--t12) var(--mono);
  }
  @media (max-height: 800px) {
    .keys {
      display: none;
    }
  }
</style>
