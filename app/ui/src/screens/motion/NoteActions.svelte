<!-- Edit, Resolve or Reopen (when the service has them), and Remove (the parent sets `--remove-opacity` to show it only on hover) for one note. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import ConfirmInline from '../../lib/components/ConfirmInline.svelte';
  import { useMotion } from './motion.svelte';
  import type { SceneNote } from './types';

  interface Props {
    note: SceneNote;
    onedit: () => void;
  }

  let { note, onedit }: Props = $props();

  const motion = useMotion();
</script>

<div class="row">
  <!-- Edit and Resolve only when the service has notes.edit / notes.resolve (hello types); without them every press
       only failed with "next studio update" -->
  {#if motion.supports('notes.edit')}
    <Button
      size="sm"
      variant="text"
      onclick={(event) => {
        event.stopPropagation();
        onedit();
      }}>Edit</Button
    >
  {/if}
  {#if motion.supports('notes.resolve')}
    <Button
      size="sm"
      variant="text"
      onclick={(event) => {
        event.stopPropagation();
        void motion.resolveNote(note);
      }}>{note.resolved ? 'Reopen' : 'Resolve'}</Button
    >
  {/if}
  <!-- Remove asks first; its clicks must not also pick the note and move the video. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <span class="remove" onclick={(event) => event.stopPropagation()}>
    <ConfirmInline
      label="Remove"
      question="Remove this note and its lesson?"
      yes="Remove"
      no="Keep"
      onyes={() => motion.removeNote(note.id)}
    />
  </span>
</div>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    margin-top: var(--s-4);
  }
  .remove {
    opacity: var(--remove-opacity, 1);
    transition: opacity var(--dur-fast) var(--ease);
  }
</style>
