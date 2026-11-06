<!-- Going back on a stage, asked first in place: what to change (the owner's words), what is made again and which
     OKs are taken back (stage.remakes), and the cost first when a paid step would start without its own cost OK.
     reopen = the stage's last OK'd step goes back with the words (stage.reopen); remake = the step in review goes
     back for changes (review.respond changes). Nothing is sent until the button is pressed. -->
<script lang="ts">
  import { creditsText } from '../cost-ok';
  import type { StepCost } from '../service/types';
  import { demoCaller, demoStatuses, stageDemo } from '../stage-demo';
  import { goBackOf, isPaidStep, type Caller } from '../stage-tools.svelte';
  import { stageById, type StageId } from '../stages';
  import { useProject, useService } from '../stores/context';
  import { plural } from '../words';
  import Button from './Button.svelte';
  import CostPrompt from './CostPrompt.svelte';
  import StatusMark from './StatusMark.svelte';

  interface Props {
    stage: StageId;
    onclose: () => void;
    /** Default: the service. */
    service?: Caller;
  }

  let { stage, onclose, service }: Props = $props();

  interface Remade {
    step: string;
    name: string;
    stage: string;
    pieces: number;
  }

  const fallback = useService();
  // svelte-ignore state_referenced_locally
  const client: Caller = stageDemo() === 'reopen' ? demoCaller : (service ?? fallback);
  const project = useProject();
  const back = $derived(goBackOf(stageById(stage), demoStatuses(project.statuses)));
  const label = $derived(stageById(stage).label);

  let text = $state('');
  let remade = $state<Remade[] | null>(null);
  /** Paid steps this would run whose cost the service will not ask about first. */
  let costs = $state<StepCost[]>([]);
  /** Paid steps that wait for the owner's cost OK before they spend. */
  let asksFirst = $state(false);
  let sending = $state(false);
  let failed = $state('');

  // Read whenever the step to go back on is known or changes (statuses can land after this opened), not only once.
  const backKey = $derived(back?.key);
  const backStep = $derived(back?.step.key);
  let loads = 0;
  $effect(() => {
    const key = backKey;
    const step = backStep;
    if (key && step) void load(key, step);
  });

  async function load(key: string, step: string) {
    const ticket = ++loads;
    let found: Remade[];
    try {
      const answer = await client.call<{ remade: Remade[] }>('stage.remakes', { stage: key });
      found = answer.remade ?? [];
    } catch {
      found = [];
    }
    if (ticket !== loads) return;
    remade = found;
    const paid = [step, ...found.map((entry) => entry.step)].filter(isPaidStep);
    const answers = await Promise.all(
      [...new Set(paid)].map((paidStep) => client.call<StepCost>('step.cost', { step: paidStep }).catch(() => null)),
    );
    if (ticket !== loads) return;
    const spending = answers.filter((cost): cost is StepCost => Boolean(cost && !cost.free));
    asksFirst = spending.some((cost) => cost.ask_first);
    costs = spending.filter((cost) => !cost.ask_first);
  }

  const credits = $derived(costs.reduce((sum, cost) => sum + (cost.estimate_credits ?? 0), 0));

  /** Sends it; throws when the service refuses, so CostPrompt (run={deliver}) keeps itself open with the reason. */
  async function deliver() {
    if (!back || !text.trim()) return;
    if (back.kind === 'reopen') await client.call('stage.reopen', { stage: back.key, text: text.trim() });
    else
      await client.call('review.respond', {
        step: back.step.key,
        verdict: 'changes',
        notes: text.trim(),
      });
    onclose();
  }

  /** The plain button: the same send, its failure shown under the words. */
  async function send() {
    sending = true;
    failed = '';
    try {
      await deliver();
    } catch (error) {
      failed = error instanceof Error ? error.message : 'unknown error';
    }
    sending = false;
  }

  const go = $derived(back?.kind === 'reopen' ? `Reopen ${label}` : `Make ${label} again`);
</script>

{#if !back}
  <p class="muted">Nothing in {label} is made or OK’d yet, so there is nothing to go back on.</p>
{:else}
  <div class="reopen">
    <p>
      {#if back.kind === 'reopen'}
        Your OK on <b>{back.step.name}</b> is taken back and it is made again with your words.
      {:else}
        <b>{back.step.name}</b> goes back with your words and is made again. Pieces you OK’d in it may be made again
        too.
      {/if}
    </p>
    {#if remade === null}
      <StatusMark mark="busy" text="Finding what is made again after it…" />
    {:else if remade.length}
      <div class="list">
        <p>Made again after it, with their OKs taken back:</p>
        <ul>
          {#each remade as entry (entry.step)}
            <li>
              <span class="nowrap">{entry.name}</span>
              {#if entry.pieces}<span class="muted nowrap">· {plural(entry.pieces, 'piece')}</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <p class="muted">Nothing after it is made yet, so nothing else is made again.</p>
    {/if}
    {#if asksFirst}
      <p class="muted">A paid step in this waits for your OK on its cost before it spends anything.</p>
    {/if}
    <label class="field">
      <span>What should change?</span>
      <textarea rows="3" bind:value={text} placeholder="Say it in your own words"></textarea>
    </label>
    {#if failed}<p class="bad" role="alert">Not sent: {failed}. Nothing was changed.</p>{/if}
    <div class="row">
      {#if costs.length && text.trim()}
        <CostPrompt
          label={go}
          size="md"
          cost={{ what: 'ElevenLabs credits', amount: creditsText(credits).replace(/ credits$/, '') }}
          run={deliver}
        />
      {:else}
        <Button variant="primary" disabled={sending || !text.trim()} onclick={send}
          >{sending ? 'Sending…' : go}</Button
        >
      {/if}
      <Button variant="text" onclick={onclose}>Keep it as it is</Button>
    </div>
  </div>
{/if}

<style>
  .reopen {
    display: grid;
    gap: var(--s-12);
    max-width: var(--reading);
  }
  .list ul {
    display: grid;
    gap: var(--s-4);
    margin-top: var(--s-4);
    padding-left: var(--s-16);
  }
  .field {
    display: grid;
    gap: var(--s-4);
    font-size: var(--t13);
    color: var(--muted);
  }
  textarea {
    padding: var(--s-8) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    color: var(--text);
    font-size: var(--t14);
    resize: vertical;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-12);
    align-items: center;
  }
  .row :global(button) {
    white-space: nowrap;
    flex-shrink: 0;
  }
  .muted {
    color: var(--muted);
  }
  .bad {
    color: var(--bad);
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
