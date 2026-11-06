<!-- The small line above a note: where it points (a link that jumps the video there), where it came from, its
     type, its version when that is not the one on show, and whether it was sent. -->
<script lang="ts">
  import { useMotion } from './motion.svelte';
  import { noteTypeName, noteWhere } from './scenes';
  import type { SceneNote } from './types';

  interface Props {
    note: SceneNote;
    /** Set when the note belongs to another version than the one shown. */
    version: number | null;
  }

  let { note, version }: Props = $props();

  const motion = useMotion();

  const sent = $derived(note.resolved ? '✓ Resolved' : note.pending ? 'Not sent' : '✓ Sent');
</script>

<span class="meta">
  <button
    class="go"
    type="button"
    onclick={(event) => {
      event.stopPropagation();
      motion.pickNote(note);
    }}>{noteWhere(note)}</button
  >
  {#if note.tablet}<span>▯ from the tablet</span>{/if}
  {#if note.type}<span class="type">{noteTypeName(note.type)}</span>{/if}
  {#if version !== null}<span>Version {version}</span>{/if}
  <span class="state" class:sent={!note.pending && !note.resolved}>{sent}</span>
</span>

<style>
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s-8);
    color: var(--muted);
    font-size: var(--t12);
  }
  .meta > * {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .go {
    padding: 0;
    border: 0;
    background: none;
    color: var(--link);
    font: 400 var(--t12) / 1.3 var(--mono);
    text-decoration: underline;
    cursor: pointer;
  }
  .type {
    padding: 0 var(--s-8);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
  }
  .state {
    margin-left: auto;
  }
  .sent {
    color: var(--good);
  }
</style>
