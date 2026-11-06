<!-- Drafts this tab did not start: offered, never loaded by themselves (owner's directors, 2026-11-02: a second
     window loaded and saved over someone else's draft). Continue makes it this tab's draft; Delete waits a few
     seconds with Undo before the service removes it. -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import { useNewProject } from './context';
  import { draftWhen } from './drafts';

  const project = useNewProject();
  const { draft } = project;
  const id = $props.id();

  const SHOWN = 3;
  const UNDO_MS = 6000;

  let all = $state(false);
  /** Drafts waiting out their Undo, by id. */
  let leaving = $state<Record<string, ReturnType<typeof setTimeout>>>({});

  const list = $derived(draft.others);
  const shown = $derived(all ? list : list.slice(0, SHOWN));

  const without = <T,>(map: Record<string, T>, key: string): Record<string, T> =>
    Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));

  function remove(draftId: string) {
    const timer = setTimeout(() => {
      void project.soft.call('brief.draft.delete', { draft: draftId });
      draft.others = draft.others.filter((d) => d.id !== draftId);
      leaving = without(leaving, draftId);
    }, UNDO_MS);
    leaving = { ...leaving, [draftId]: timer };
  }

  function undo(draftId: string) {
    clearTimeout(leaving[draftId]);
    leaving = without(leaving, draftId);
  }

  onDestroy(() => {
    // Leaving the page counts as letting the Undo run out.
    for (const [draftId, timer] of Object.entries(leaving)) {
      clearTimeout(timer);
      void project.soft.call('brief.draft.delete', { draft: draftId });
    }
  });
</script>

{#if list.length && !project.busy}
  <section class="drafts" aria-labelledby="{id}-head">
    <h2 id="{id}-head">Continue a draft <span class="count">{list.length}</span></h2>
    <ul>
      {#each shown as other (other.id)}
        <li>
          {#if leaving[other.id]}
            <span class="gone" role="status">Draft deleted.</span>
            <Button size="sm" variant="text" onclick={() => undo(other.id)}>Undo</Button>
          {:else}
            <span class="idea" title={other.idea_excerpt}>{other.idea_excerpt || 'No idea written yet'}</span>
            <span class="meta"
              >{draftWhen(other.saved_at)}{other.sources
                ? ` · ${other.sources} source${other.sources === 1 ? '' : 's'}`
                : ''}</span
            >
            <Button size="sm" onclick={() => void project.continueDraft(other.id)}>Continue</Button>
            <Button size="sm" variant="text" aria-label="Delete this draft" onclick={() => remove(other.id)}
              >Delete</Button
            >
          {/if}
        </li>
      {/each}
    </ul>
    {#if list.length > SHOWN}
      <Button size="sm" variant="text" aria-expanded={all} onclick={() => (all = !all)}
        >{all ? 'Show fewer' : `Show all ${list.length}`}</Button
      >
    {/if}
  </section>
{/if}

<style>
  .drafts {
    display: grid;
    gap: var(--s-8);
    justify-items: start;
    padding-bottom: var(--s-16);
    border-bottom: 1px solid var(--line);
  }
  h2 {
    color: var(--muted);
    font: 600 var(--t12) / 1 var(--body);
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .count {
    color: var(--faint);
  }
  ul {
    display: grid;
    width: 100%;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--s-12);
    min-height: var(--h);
    border-top: 1px solid var(--line);
  }
  li:first-child {
    border-top: 0;
  }
  .idea {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--t14);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta,
  .gone {
    color: var(--muted);
    font-size: var(--t13);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .gone {
    flex: 1;
  }
</style>
