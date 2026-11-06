<!-- Hear the line, queue a new read (paid, confirmed later) or approve it. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import InspectorSection from '../../lib/components/InspectorSection.svelte';
  import Hint from './Hint.svelte';
  import { credits, VOICE_ACTIONS } from './review';
  import type { VoiceModel } from './model.svelte';
  import type { VoiceLine } from './types';

  interface Props {
    model: VoiceModel;
    line: VoiceLine;
  }

  let { model, line }: Props = $props();

  const id = $derived(line.node);
  const queued = $derived(model.basket.lines.get(id));
  const noKey = $derived(model.noKey);
  /** The studio tried to make it and could not: a new try is the way on, even with no audio yet. */
  const failed = $derived(line.state === 'needs you' && !line.path);
</script>

<InspectorSection title="Listen, re-read, approve">
  <div class="actions">
    <Button disabled={!line.path} onclick={() => model.player.playLine(line)}>▶ Preview current</Button>
    <Button
      disabled={!line.path}
      title="The line before, this line and the line after, with the music under it"
      onclick={() => model.previewInContext(line)}
    >
      ▶ Preview in context
    </Button>
    {#if queued}
      <Button variant="cost" size="sm" onclick={() => model.basket.unstage(id)}>
        {queued.credits === null
          ? 'Queued · working out the cost…'
          : `Queued · about ${credits(queued.credits)} credits · remove`}
      </Button>
    {:else}
      <Button
        variant="cost"
        disabled={!model.cast.ready || model.isSent(id) || (!line.path && !failed) || !!noKey}
        title={noKey ?? 'Queues a new read. Nothing is spent until you make the queue and confirm the cost.'}
        onclick={() => model.queueReread(id)}
      >
        {failed ? 'Queue a new try' : VOICE_ACTIONS.reread}
      </Button>
    {/if}
    <Button
      variant="good"
      disabled={line.state === 'approved' || !line.path}
      title={line.path ? '' : 'There is nothing to approve until the line is made'}
      onclick={() => model.approve(line)}
    >
      {line.state === 'approved' ? VOICE_ACTIONS.approved : VOICE_ACTIONS.approve}
    </Button>
  </div>
  <Hint>Preview and pause are free. A re-read is queued and costs credits you confirm first.</Hint>
</InspectorSection>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
</style>
