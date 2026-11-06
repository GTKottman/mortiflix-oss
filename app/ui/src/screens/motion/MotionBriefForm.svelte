<!-- The Motion brief (motion.brief.get / motion.brief.set): a motion pack (or "the AI decides"), rule packs the AI
     follows, and the owner's words. Saving changes what is made from now on; scenes already made stay as they are. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import type { Caller } from '../../lib/stage-tools.svelte';
  import { useService } from '../../lib/stores/context';

  interface Props {
    /** Default: the service. */
    service?: Caller;
  }

  let { service }: Props = $props();

  interface MotionBrief {
    motion_pack?: { id: string } | null;
    rule_packs?: { id: string }[];
    words?: string;
  }
  interface Pack {
    id: string;
    name: string;
    description?: string;
  }

  const fallback = useService();
  // svelte-ignore state_referenced_locally
  const client: Caller = service ?? fallback;

  let loaded = $state(false);
  /** Why the stored brief could not be read. The form is not shown then: Save would overwrite the real brief. */
  let loadFailed = $state('');
  let motionPacks = $state<Pack[]>([]);
  let rulePacks = $state<Pack[]>([]);
  let motion = $state('');
  let rules = $state<string[]>([]);
  let words = $state('');
  let saving = $state(false);
  let said = $state('');
  let failed = $state('');

  onMount(() => void load());

  async function load() {
    loaded = false;
    loadFailed = '';
    const [brief, motionList, ruleList] = await Promise.all([
      // A failed read is not "no brief yet" (null): keep the reason apart (same as LookBriefForm, C622).
      client.call<MotionBrief | null>('motion.brief.get').then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : 'unknown error' }),
      ),
      client.call<Pack[]>('packs.list', { kind: 'motion' }).catch(() => []),
      client.call<Pack[]>('packs.list', { kind: 'rule' }).catch(() => []),
    ]);
    if ('error' in brief) {
      loadFailed = brief.error;
      loaded = true;
      return;
    }
    motionPacks = motionList;
    rulePacks = ruleList;
    const stored = brief.answer;
    motion = stored?.motion_pack?.id ?? '';
    rules = (stored?.rule_packs ?? []).map((pack) => pack.id);
    words = stored?.words ?? '';
    loaded = true;
  }

  async function save() {
    if (loadFailed || saving) return;
    saving = true;
    failed = '';
    said = '';
    try {
      await client.call('motion.brief.set', { motion_pack: motion || null, rule_packs: rules, words });
      said = 'Saved. What is made from now on uses it.';
    } catch (error) {
      failed = error instanceof Error ? error.message : 'unknown error';
    }
    saving = false;
  }
</script>

{#if !loaded}
  <LoadingState text="Loading the brief…" />
{:else if loadFailed}
  <ErrorState inline title="Couldn't read the brief" detail={loadFailed} onretry={() => void load()} />
{:else}
  <form
    class="brief"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <p class="muted">Scenes made from now on follow it. Scenes already made stay as they are.</p>
    <label>
      <span>Motion pack</span>
      <select bind:value={motion}>
        <option value="">The AI decides</option>
        {#each motionPacks as pack (pack.id)}<option value={pack.id}>{pack.name}</option>{/each}
      </select>
    </label>
    <fieldset>
      <legend>Rule packs the AI follows</legend>
      {#each rulePacks as pack (pack.id)}
        <label class="check">
          <input type="checkbox" value={pack.id} bind:group={rules} />
          <span>{pack.name}</span>
        </label>
      {:else}
        <p class="muted">No rule packs yet.</p>
      {/each}
    </fieldset>
    <label>
      <span>Your words</span>
      <textarea rows="3" bind:value={words}></textarea>
    </label>
    {#if failed}<p class="bad" role="alert">Not saved: {failed}</p>{/if}
    {#if said}<p class="good" role="status">{said}</p>{/if}
    <div class="row">
      <Button variant="primary" type="submit" disabled={saving}
        >{saving ? 'Saving…' : 'Save the brief'}</Button
      >
    </div>
  </form>
{/if}

<style>
  .brief {
    display: grid;
    gap: var(--s-12);
    max-width: var(--reading);
  }
  label,
  legend {
    display: grid;
    gap: var(--s-4);
    color: var(--muted);
    font-size: var(--t13);
  }
  label span,
  legend {
    white-space: nowrap;
  }
  fieldset {
    display: grid;
    gap: var(--s-8);
    border: 0;
    padding: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    color: var(--text);
    font-size: var(--t14);
  }
  select,
  textarea {
    min-height: var(--h-sm);
    padding: var(--s-4) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    color: var(--text);
    font-size: var(--t14);
  }
  textarea {
    resize: vertical;
  }
  .row {
    display: flex;
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
  .good {
    color: var(--good);
  }
</style>
