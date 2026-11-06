<!-- How lively or steady the line is read. Needs a new read (paid), so it goes to the queue. -->
<script lang="ts">
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import Slider from '../../lib/components/Slider.svelte';
  import Hint from './Hint.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
  }

  let { model, line }: Props = $props();

  const id = $derived(line.node);
  const locked = $derived(!model.cast.ready);

  // Starts at what the line has now; moving the slider changes it until the line changes.
  let stability = $derived(
    model.basket.lines.get(id)?.patch.stability ??
      model.checkOf(id)?.stability ??
      model.cast.member(model.roleOf(id))?.settings?.stability ??
      0.5,
  );
</script>

<InspectorSection title="Expressiveness">
  {#if locked}
    <Hint>Off until the cast loads (see Voices and cast below).</Hint>
  {:else}
    <Slider
      label="Expressiveness for this line"
      bind:value={stability}
      min={0}
      max={1}
      step={0.05}
      startLabel="More expressive"
      endLabel="Steadier"
      format={(value) => value.toFixed(2)}
      onchange={(value) => model.basket.stage(id, { stability: value })}
    />
  {/if}
  <Hint>Lower is livelier and more varied; higher is calmer and more even. Needs a new read (paid).</Hint>
</InspectorSection>
