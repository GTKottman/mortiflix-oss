<!-- The line's words with their timing (click a word to play from it), what differs from the script, and the way to
     edit the words on Script. -->
<script lang="ts">
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import Hint from './Hint.svelte';
  import TakeStepper from './TakeStepper.svelte';
  import WordsStrip from './WordsStrip.svelte';
  import type { VoiceModel } from './model.svelte';
  import type { TakeVersion, VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
    versions: readonly TakeVersion[];
    inUse: number;
  }

  let { model, line, versions, inUse }: Props = $props();
</script>

<InspectorSection title="Words">
  <div class="heading">
    <span>Words &amp; timing</span>
    <span class="click">click a word to play from it</span>
    {#if versions.length > 1}
      <TakeStepper
        {inUse}
        count={versions.length}
        onuse={(index) => model.useTake(line.node, versions, index)}
      />
    {/if}
  </div>
  <WordsStrip {model} {line} check={model.checkOf(line.node)} />
  <Hint>
    Dashed = heard but not in the script · struck through = in the script but not heard. The words themselves
    are edited on Script.
  </Hint>
  <a href={routeHref(`/script?line=${encodeURIComponent(line.node)}`)}>Edit the words on Script</a>
</InspectorSection>

<style>
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-12);
    color: var(--muted);
    font-size: var(--t12);
  }
  .heading > span {
    white-space: nowrap;
  }
  .click {
    font-size: var(--t14);
    line-height: 1.55;
  }
  a {
    justify-self: start;
    font-size: var(--t14);
    text-underline-offset: 3px;
  }
</style>
