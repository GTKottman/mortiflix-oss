<!-- The selected line's state, and whether the words heard match the script. -->
<script lang="ts">
  import StatusPill from '../../lib/components/StatusPill.svelte';
  import { differingWords } from './review';
  import { differenceNote, lineStatus } from './status';
  import type { VoiceModel } from './model.svelte';
  import type { VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
  }

  let { model, line }: Props = $props();

  const word = $derived(lineStatus(line, model.isMaking(line)));
  const check = $derived(model.checkOf(line.node));
  const matches = $derived(check?.ok === true || (!check && line.checked && line.words_ok === true));
</script>

<span class="status">
  <StatusPill pill small tone={word.tone} glyph={word.glyph} text={word.text} />
  {#if line.words_changed && !model.isMaking(line)}
    <small class="bad">words changed: the take says the old words</small>
  {:else if model.isBad(line)}
    <small class="bad">{differenceNote(differingWords(check))}</small>
  {:else if matches}
    <small>✓ words match</small>
  {/if}
</span>

<style>
  .status {
    display: grid;
    justify-items: start;
  }
  small {
    color: var(--faint);
    font-size: var(--t13);
  }
  .bad {
    color: var(--warn);
  }
</style>
