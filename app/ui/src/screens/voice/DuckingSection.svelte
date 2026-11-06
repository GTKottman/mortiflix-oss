<!-- How far the music drops while someone speaks. Free: heard at the next "Mix under the voice". -->
<script lang="ts">
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import Slider from '../../lib/components/Slider.svelte';
  import Hint from './Hint.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { MusicCue } from './types';

  interface Props {
    model: VoiceModel;
    cue: MusicCue;
  }

  let { model, cue }: Props = $props();

  let duck = $derived(cue.duck_db ?? -12);
</script>

<InspectorSection title="Ducking">
  <Slider
    label="Ducking"
    bind:value={duck}
    min={-30}
    max={0}
    step={1}
    startLabel="Quieter"
    endLabel="Louder"
    format={(value) => `${value} dB`}
    onchange={(value) => model.music.setCue(cue.id, { duck_db: value })}
  />
  <Hint free>
    how far the music drops while someone is speaking. −12 dB is clearly quieter. Heard the next time you mix
    under the voice.
  </Hint>
</InspectorSection>
