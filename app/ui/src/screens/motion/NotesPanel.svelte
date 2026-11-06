<!-- The notes on this scene, in time order, newest version's marks first in the eye (older ones are dimmed). -->
<script lang="ts">
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import { useMotion } from './motion.svelte';
  import NoteRow from './NoteRow.svelte';

  const motion = useMotion();

  const notes = $derived(motion.sceneNotes);

  /** What the empty list says, by where the scene is: approved, ready to judge, being made, or not made yet. */
  const empty = $derived.by(() => {
    const state = motion.scene?.state;
    if (state === 'ok') return { title: 'No notes', body: 'This scene is approved.' };
    if (!motion.canNote) {
      return state === 'review'
        ? { title: 'No notes yet', body: 'Notes open once this scene has a picture.' }
        : { title: 'No notes yet', body: 'Notes open once this scene is made.' };
    }
    if (state === 'review') return { title: 'No notes yet', body: 'Mark a frame or approve this scene.' };
    return { title: 'No notes yet', body: 'Mark a frame to leave a note while this scene is made.' };
  });
</script>

{#if motion.soon}
  <EmptyState
    title="Coming in the next studio update"
    body="Notes and lessons arrive with it. Nothing is lost."
  />
{:else if motion.scene}
  {#each notes as note (note.id)}<NoteRow {note} />{:else}
    <EmptyState title={empty.title} body={empty.body} />
  {/each}
{/if}
