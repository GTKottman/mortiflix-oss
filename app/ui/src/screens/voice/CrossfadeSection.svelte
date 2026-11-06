<!-- How long this music blends into the next. The crossfade is part of the music's length (elmusic.mjs cueLength), so
     on music already made a change marks it stale: it must be made again (paid) and approved again. -->
<script lang="ts">
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import Hint from './Hint.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { MusicCue } from './types';

  interface Props {
    model: VoiceModel;
    cue: MusicCue;
  }

  const LONGEST = 8;

  let { model, cue }: Props = $props();
</script>

<InspectorSection title="Crossfade">
  <div class="stepper">
    <input
      type="number"
      min="0"
      max={LONGEST}
      step="0.5"
      value={cue.crossfade_sec}
      aria-label="Crossfade in seconds"
      onchange={(event) => model.music.setCue(cue.id, { crossfade_sec: Number(event.currentTarget.value) })}
    />
    <span>seconds</span>
  </div>
  <div
    class="bar"
    style:width="{Math.min(100, ((cue.crossfade_sec ?? 0) / LONGEST) * 100)}%"
    aria-hidden="true"
  ></div>
  {#if cue.path}
    <Hint>how long this music blends into the next one. Shorter is free; longer means this music is made again (paid).</Hint>
  {:else}
    <Hint free>how long this music blends into the next one. Nothing is made yet.</Hint>
  {/if}
</InspectorSection>

<style>
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: var(--s-8);
    color: var(--muted);
    font-size: var(--t12);
  }
  input {
    width: calc(var(--s-64) + var(--s-16));
    height: var(--h);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--ink-2);
    font-size: var(--t14);
    text-align: center;
  }
  .bar {
    height: var(--s-8);
    border-radius: var(--r-pill);
    background: linear-gradient(90deg, var(--ink-4), var(--text));
    opacity: 0.6;
  }
</style>
