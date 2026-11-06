<!-- The inspector for a selected music cue: what the music should be, energy, how far it ducks under the voice, how
     it blends into the next cue, then listen / queue a new one / approve. Ducking and crossfade are free and change
     the mix at once; a new prompt or energy needs new music (paid, through the queue). -->
<script lang="ts">
  import CrossfadeSection from './CrossfadeSection.svelte';
  import CueListenSection from './CueListenSection.svelte';
  import DuckingSection from './DuckingSection.svelte';
  import EnergySection from './EnergySection.svelte';
  import Hint from './Hint.svelte';
  import PromptSection from './PromptSection.svelte';
  import ReviewReason from './ReviewReason.svelte';
  import { CUE_REASON } from './review';
  import type { VoiceModel } from './model.svelte';
  import type { MusicCue } from './types';

  interface Props {
    model: VoiceModel;
    cue: MusicCue;
  }

  let { model, cue }: Props = $props();

  let note = $state<string | null>(null);
</script>

{#if note}<div role="status"><Hint>{note}</Hint></div>{/if}
{#if cue.state !== 'ok'}<ReviewReason why={CUE_REASON[cue.state].toLowerCase()} />{/if}
<PromptSection {model} {cue} />
<EnergySection {model} {cue} />
<DuckingSection {model} {cue} />
<CrossfadeSection {model} {cue} />
<CueListenSection {model} {cue} onnote={(next) => (note = next)} />
