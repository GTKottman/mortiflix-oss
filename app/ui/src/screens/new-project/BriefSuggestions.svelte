<!-- What Improve my brief came back with, under the idea box: each change is yours to take or leave. -->
<script lang="ts">
  import { useNewProject } from './context';
  import Note from './Note.svelte';
  import SuggestionItem from './SuggestionItem.svelte';

  const { form, live } = useNewProject();
</script>

{#if form.idea.trim() && (live.suggestions.length || live.improved)}
  <section class="suggestions" aria-label="Suggested changes">
    <h2>Suggested changes (you decide)</h2>
    {#each live.suggestions as suggestion (suggestion.id)}<SuggestionItem {suggestion} />{:else}
      <Note>{live.note ?? 'Nothing to add. Your brief reads clearly.'}</Note>
    {/each}
    <Note>Uses your Claude subscription. No credits.</Note>
  </section>
{/if}

<style>
  .suggestions {
    display: grid;
    gap: var(--s-8);
  }
  h2 {
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
</style>
