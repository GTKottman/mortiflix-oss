<!-- Top right of the head: how many things need a look, and Previous / Next issue to go through them. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { REVIEW_BAR } from './review';
  import type { VoiceModel } from './model.svelte';

  interface Props {
    model: VoiceModel;
  }

  let { model }: Props = $props();
  const count = $derived(model.issues.length);
  const ready = $derived(model.approvable.lines.length + model.approvable.cues.length);
  let approving = $state(false);
  async function approveAll(): Promise<void> {
    approving = true;
    await model.approveAll();
    approving = false;
  }
</script>

<div class="review">
  {#if ready}
    <Button size="sm" variant="good" disabled={approving} title="You listened and it is good: approve every made line and music segment" onclick={approveAll}>
      {approving ? 'Approving…' : REVIEW_BAR.approveAll(ready)}
    </Button>
  {/if}
  <Button
    size="sm"
    variant={count ? 'cost' : 'text'}
    disabled={!count}
    aria-expanded={model.issuesOpen}
    title={count ? 'Show what needs a look' : 'Nothing is waiting'}
    onclick={() => (model.issuesOpen = !model.issuesOpen)}
  >
    {count ? REVIEW_BAR.count(count) : REVIEW_BAR.none}
  </Button>
  <Button size="sm" disabled={!count} onclick={() => model.goToIssue(-1)}>{REVIEW_BAR.previous}</Button>
  <Button size="sm" disabled={!count} onclick={() => model.goToIssue(1)}>{REVIEW_BAR.next}</Button>
</div>

<style>
  .review {
    display: flex;
    align-items: center;
    gap: var(--s-8);
  }
</style>
