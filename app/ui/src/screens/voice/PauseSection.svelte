<!-- The silence after the line, in seconds. Free: saved at once, the line is not re-read. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import Hint from './Hint.svelte';
  import { pauseAfter } from './review';
  import type { VoiceModel } from './model.svelte';
  import type { VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
  }

  const STEP = 0.05;

  let { model, line }: Props = $props();

  const id = $derived(line.node);
  const pause = $derived(pauseAfter(model.lines, model.lines.indexOf(line), model.checkOf(id)));
  const off = $derived(!model.cast.ready || pause === null);
</script>

<InspectorSection title="Pause after the line">
  <div class="stepper">
    <Button
      size="sm"
      aria-label="Shorter pause"
      disabled={off}
      onclick={() => model.setPause(id, (pause ?? 0) - STEP)}>−</Button
    >
    <input
      type="number"
      min="0"
      max="5"
      step={STEP}
      value={pause === null ? '' : pause.toFixed(2)}
      aria-label="Pause in seconds"
      disabled={off}
      onchange={(event) => model.setPause(id, Number(event.currentTarget.value))}
    />
    <span>s</span>
    <Button
      size="sm"
      aria-label="Longer pause"
      disabled={off}
      onclick={() => model.setPause(id, (pause ?? 0) + STEP)}>+</Button
    >
  </div>
  {#if pause === null}
    <Hint>The last line has no pause after it.</Hint>
  {:else if model.pauseWait}
    <Hint>{model.pauseWait}.</Hint>
  {:else}
    <Hint free>saved at once; the line is not re-read.</Hint>
  {/if}
</InspectorSection>

<style>
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: var(--s-8);
    height: var(--h);
    color: var(--text);
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
</style>
