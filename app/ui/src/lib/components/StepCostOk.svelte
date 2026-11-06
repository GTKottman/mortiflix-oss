<!-- Cost first for a step Mortiflix would start by itself (the voice, the music, the new sounds): "Ready to record the
     voice: about 493 credits · [Make the voice]". Nothing paid starts until the owner presses it and confirms the cost
     (CostPrompt); the service waits with needs_you {kind:'cost_ok'} until then (step.confirm_cost). `ahead` shows it
     before the service is waiting (the Script screen once the script is OK'd); `who` is the voice choice, if any. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { creditsText, goText, readyText, showCostOk, type PaidStep } from '../cost-ok';
  import type { StepCost } from '../service/types';
  import { useProject, useService } from '../stores/context';
  import CostPrompt from './CostPrompt.svelte';

  interface Props {
    step: PaidStep;
    ahead?: boolean;
    /** Bump to read the cost again (the voice changed). */
    version?: number;
    who?: Snippet<[StepCost]>;
  }

  let { step, ahead = false, version = 0, who }: Props = $props();

  const client = useService();
  const project = useProject();
  let cost = $state<StepCost | null>(null);
  /** Latest-wins: the effect, project.changed and confirm can read at once; only the newest answer is shown. */
  let loads = 0;

  async function load() {
    const ticket = ++loads;
    let answer: StepCost | null;
    try {
      answer = await client.call<StepCost>('step.cost', { step });
    } catch {
      answer = null; // an older service: no cost-first gate to show
    }
    if (ticket === loads) cost = answer;
  }

  $effect(() => {
    void version;
    void project.id;
    void project.needsYou;
    void load();
  });
  $effect(() =>
    client.on<{ id?: string }>('project.changed', (event) => event.id === project.id && void load()),
  );

  async function confirm() {
    await client.call('step.confirm_cost', { step });
    await load();
  }
</script>

{#if cost && showCostOk(cost, ahead)}
  <div class="cost-ok" role="group" aria-label={readyText(step)}>
    <span>{readyText(step)}:</span>
    {#if who}{@render who(cost)}<span class="dot">·</span>{/if}
    <span>{creditsText(cost.estimate_credits)}</span>
    <span class="dot">·</span>
    <CostPrompt
      label={goText(step)}
      variant="primary"
      cost={{
        what: 'ElevenLabs credits',
        amount:
          typeof cost.estimate_credits === 'number'
            ? `about ${cost.estimate_credits.toLocaleString('en-US')}`
            : 'some',
        note: step === 'voice' && cost.lines ? `${cost.lines} lines, a character a credit` : undefined,
      }}
      run={confirm}
    />
  </div>
{/if}

<style>
  .cost-ok {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    padding: var(--s-12) 0;
    font-size: var(--t14);
  }
  .dot {
    color: var(--muted);
  }
</style>
