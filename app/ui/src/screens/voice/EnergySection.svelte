<!-- How loud the music sits in the mix (elmusic.mjs: energy only sets the mix gain, it is never sent to ElevenLabs).
     Free: heard at the next "Mix under the voice". -->
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

  let energy = $derived(cue.energy ?? 0.5);
</script>

<InspectorSection title="Energy">
  <Slider
    label="Energy"
    bind:value={energy}
    min={0}
    max={1}
    step={0.05}
    startLabel="Subtle"
    endLabel="Intense"
    format={(value) => value.toFixed(2)}
    onchange={(value) => model.music.setCue(cue.id, { energy: value })}
  />
  <Hint free>how strongly it comes through in the mix. Heard the next time you mix under the voice.</Hint>
</InspectorSection>
