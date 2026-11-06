<!-- The right-hand inspector: the overview when nothing is selected, otherwise the selected voice line or music cue
     with its state, arrows and options. -->
<script lang="ts">
  import Accordion from '../../lib/components/Accordion.svelte';
  import Inspector from '../../lib/components/Inspector.svelte';
  import OptionsRow from '../../lib/components/OptionsRow.svelte';
  import CastPanel from './CastPanel.svelte';
  import CueActions from './CueActions.svelte';
  import CuePanel from './CuePanel.svelte';
  import { cueSubtitle, cueTitle, lineSubtitle, spokenBy } from './heading';
  import LineActions from './LineActions.svelte';
  import LinePanel from './LinePanel.svelte';
  import OverviewPanel from './OverviewPanel.svelte';
  import { cueName } from './review';
  import type { VoiceModel } from './model.svelte';

  interface Props {
    model: VoiceModel;
  }

  let { model }: Props = $props();

  const line = $derived(model.lineById(model.selectedLine));
  const cue = $derived(model.music.cue(model.selectedCue ?? null));
  const target = $derived(model.selectedLine ?? model.selectedCue ?? undefined);
  const targetLabel = $derived(
    model.selectedLine
      ? model.nameOf(model.selectedLine)
      : model.selectedCue
        ? cueName(model.selectedCue)
        : undefined,
  );
  const spoken = $derived(line ? spokenBy(model.cast.speakerOf(model.roleOf(line.node))) : '');
  const title = $derived(line ? model.nameOf(line.node) : cue ? cueTitle(cue) : undefined);
  const subtitle = $derived(line ? lineSubtitle(line, spoken) : cue ? cueSubtitle(cue) : undefined);
</script>

{#snippet lineActions()}
  {#if line}<LineActions {model} {line} />{/if}
{/snippet}

{#snippet cueActions()}
  {#if cue}<CueActions {model} {cue} />{/if}
{/snippet}

{#snippet options()}
  {#if target}
    <OptionsRow stage="voice" {target} {targetLabel} onrun={() => void model.load()} />
  {/if}
{/snippet}

{#key model.selectedLine ?? model.selectedCue}
  <Inspector
    label="Audio inspector"
    {title}
    {subtitle}
    actions={line ? lineActions : cue ? cueActions : undefined}
    lead={line || cue ? options : undefined}
  >
    {#if line}
      <LinePanel {model} {line} />
      <Accordion title="Voices and cast" bind:open={model.castOpen}>
        <CastPanel {model} />
      </Accordion>
    {:else if cue}
      <CuePanel {model} {cue} />
    {:else}
      <OverviewPanel {model} />
    {/if}
  </Inspector>
{/key}
