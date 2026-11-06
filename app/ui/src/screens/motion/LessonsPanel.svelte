<!-- What Claude suggested from the owner's notes, and the owner's own rules. Approved rules shape the scenes made
     after this one. -->
<script lang="ts">
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import { useMotion } from './motion.svelte';
  import LessonRow from './LessonRow.svelte';

  const motion = useMotion();

  const mine = $derived(motion.lessons.filter((lesson) => lesson.approved));
  const suggested = $derived(motion.lessons.filter((lesson) => !lesson.approved));
</script>

{#if motion.soon}
  <EmptyState title="Coming in the next studio update" />
{:else if !motion.lessons.length}
  <EmptyState title="No lessons yet" body="Notes you add can suggest lessons that carry into later scenes." />
{:else}
  {#if suggested.length}
    <h3>Suggested by Claude · {suggested.length}</h3>
    {#each suggested as lesson (lesson.id)}<LessonRow {lesson} mine={false} />{/each}
  {/if}
  {#if mine.length}
    <h3>Your rules · {mine.length}</h3>
    {#each mine as lesson (lesson.id)}<LessonRow {lesson} mine />{/each}
  {/if}
  <p class="more">
    Approved rules shape scenes made after this one. <a href={routeHref('/lessons')}>All lessons ›</a>
  </p>
{/if}

<style>
  h3 {
    padding: var(--s-12) 0 var(--s-4);
    color: var(--faint);
    font-size: var(--t12);
    font-weight: 600;
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .more {
    padding-top: var(--s-12);
    color: var(--muted);
    font-size: var(--t12);
  }
  a {
    color: var(--link);
  }
</style>
