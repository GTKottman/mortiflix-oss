<!-- The inspector for a selected voice line: the words, who reads it and how, the pause after it, listen /
     re-read / approve, and its takes. Anything that needs a new read is queued (paid), never made here. -->
<script lang="ts">
  import ExpressivenessSection from './ExpressivenessSection.svelte';
  import ListenSection from './ListenSection.svelte';
  import NarratorSection from './NarratorSection.svelte';
  import PauseSection from './PauseSection.svelte';
  import RecordedTakes from './RecordedTakes.svelte';
  import ReviewReason from './ReviewReason.svelte';
  import { reasonOf, usableTakes } from './review';
  import TakesCompare from './TakesCompare.svelte';
  import WordsSection from './WordsSection.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
  }

  let { model, line }: Props = $props();

  const heard = $derived(usableTakes(model.takes.get(line.node)));
  const why = $derived(
    model.needsYou(line) ? reasonOf(line, model.checkOf(line.node), model.isMaking(line)) : null,
  );
</script>

{#if why}<ReviewReason {why} />{/if}
<!-- listen / re-read / approve first: under a long line's words it was below the fold (Dir2) -->
<ListenSection {model} {line} />
<WordsSection {model} {line} versions={heard.versions} inUse={heard.inUse} />
<NarratorSection {model} {line} />
<ExpressivenessSection {model} {line} />
<PauseSection {model} {line} />
{#if heard.versions.length > 1}
  <TakesCompare {model} {line} versions={heard.versions} inUse={heard.inUse} />
{/if}
{#if line.takes?.length}<RecordedTakes takes={line.takes} />{/if}
