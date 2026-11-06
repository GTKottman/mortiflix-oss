<!-- What needs a look, in time order: one row per line or cue, with why and when. Click one to go to it.
     It sits under the time line and never moves it. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';

  import { issueTime } from './review';
  import type { VoiceModel } from './model.svelte';

  interface Props {
    model: VoiceModel;
  }

  let { model }: Props = $props();
  const open = $derived(model.issuesOpen && model.issues.length > 0);
</script>

{#if open}
  <section class="issues" aria-label="Issues to review">
    <header>
      <span class="kicker">{model.issues.length} to review</span>
      <Button size="sm" variant="text" onclick={() => (model.issuesOpen = false)}>Close</Button>
    </header>
    <ul>
      {#each model.issues as issue (issue.id)}
        <li>
          <button
            type="button"
            onclick={() => (issue.kind === 'line' ? model.select(issue.id) : model.selectCue(issue.id))}
          >
            <span class="name">! {issue.name}</span>
            <span class="why">{issue.why}</span>
            <span class="when">{issueTime(issue)}</span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .issues {
    max-height: 30dvh;
    padding-top: var(--s-8);
    border-top: 1px solid var(--line-2);
    overflow: auto;
    scrollbar-width: thin;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .kicker {
    white-space: nowrap;
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  ul {
    list-style: none;
  }
  li {
    border-top: 1px solid var(--line);
  }
  button {
    display: grid;
    grid-template-columns: calc(var(--s-64) * 2 + var(--s-32)) 1fr auto;
    gap: var(--s-12);
    align-items: center;
    width: 100%;
    min-height: var(--h);
    padding: 0;
    border: 0;
    background: none;
    font-size: var(--t14);
    text-align: left;
    cursor: pointer;
  }
  button:hover {
    background: var(--ink-3);
  }
  .name,
  .why,
  .when {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    color: var(--warn);
    font-size: var(--t12);
    font-weight: 500;
  }
  .why {
    color: var(--muted);
  }
  .when {
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
</style>
