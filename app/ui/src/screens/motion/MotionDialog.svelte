<!-- A question before something that costs time or cannot be undone: a title, what it means, and the choices.
     A modal dialog, so the page behind cannot be reached and Esc cancels. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** Called when the dialog closed: Esc, or a choice that called `close`. */
    onclose: () => void;
    children: Snippet;
    /** The buttons; `close` shuts the dialog first. */
    actions: Snippet<[close: () => void]>;
  }

  let { title, onclose, children, actions }: Props = $props();

  const titleId = $props.id();
  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });
</script>

<dialog bind:this={dialog} aria-labelledby={titleId} {onclose}>
  <h2 id={titleId}>{title}</h2>
  {@render children()}
  <div class="acts">{@render actions(() => dialog?.close())}</div>
</dialog>

<style>
  dialog {
    width: min(560px, calc(100vw - var(--s-48)));
    max-height: calc(100vh - var(--s-64));
    margin: auto;
    padding: var(--s-24);
    border: 1px solid var(--line-2);
    border-radius: var(--r-lg);
    background: var(--ink-2);
    color: var(--text);
    overflow: auto;
  }
  dialog[open] {
    display: grid;
    gap: var(--s-12);
  }
  dialog::backdrop {
    background: var(--ink);
    opacity: 0.8;
  }
  h2 {
    font: 600 var(--t20) / 1.2 var(--display);
    letter-spacing: 0.01em;
    text-transform: uppercase;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--s-8);
    margin-top: var(--s-8);
  }
</style>
