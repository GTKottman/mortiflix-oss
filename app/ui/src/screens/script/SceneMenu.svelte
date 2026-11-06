<!-- The scene's ⋯ menu: every action for this scene in one place (Edit, Fix with a note, OK / Reopen, Undo last save,
     Rewrite with Claude's options, copy the words, hear it on Voice & music). Esc or a click outside closes it;
     arrow keys move between items. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import { useScript } from './script.svelte';
  import { isApproved, isBusy, isCut } from './timing';
  import type { Beat } from './types';

  interface Props {
    beat: Beat;
  }

  let { beat }: Props = $props();
  const script = useScript();

  const COPIED_MS = 1500;
  let open = $state(false);
  let copied = $state<'words' | 'screen' | null>(null);
  let root = $state<HTMLElement>();
  let trigger = $state<HTMLElement>();
  let menu = $state<HTMLElement>();

  const label = $derived(`scene ${beat.no}: ${beat.name}`);
  /** A cut scene is not in the video: no Edit, Fix, Rewrite or OK for it. */
  const cut = $derived(isCut(beat));
  const editable = $derived(!cut && beat.lines.some((l) => !l.read_only));
  const busy = $derived(isBusy(beat));
  const approving = $derived(Boolean(script.approving[beat.id]));
  const editing = $derived(script.editing.has(beat.id));
  const firstLine = $derived(beat.lines[0]?.id);

  const items = (): HTMLElement[] => [
    ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
  ];

  async function toggle() {
    open = !open;
    if (!open) return;
    await tick();
    items()[0]?.focus();
  }

  function close(focusTrigger = true) {
    open = false;
    if (focusTrigger) trigger?.focus();
  }

  function run(action: () => void) {
    close(false);
    action();
  }

  async function copy(what: 'words' | 'screen') {
    const text = what === 'words' ? beat.lines.map((l) => l.words).join('\n') : (beat.visual ?? '');
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      setTimeout(() => (copied = null), COPIED_MS);
    } catch {
      copied = null;
    }
  }

  function rewrite() {
    script.scope = 'scene';
    script.reveal(beat.id);
    void tick().then(() =>
      document.querySelector<HTMLElement>('[data-rewrite-options] button:not(:disabled)')?.focus(),
    );
  }

  function onMenuKey(event: KeyboardEvent) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowDown') list[(at + 1) % list.length]?.focus();
    else if (event.key === 'ArrowUp') list[(at - 1 + list.length) % list.length]?.focus();
    else if (event.key === 'Home') list[0]?.focus();
    else if (event.key === 'End') list.at(-1)?.focus();
    else if (event.key === 'Tab') close(false);
    else return;
    if (event.key !== 'Tab') event.preventDefault();
    event.stopPropagation();
  }

  function closeOn(event: Event) {
    if (open && event.target instanceof Node && !root?.contains(event.target)) open = false;
  }
</script>

<svelte:window onclick={closeOn} />

<div class="more" bind:this={root}>
  <button
    bind:this={trigger}
    class="dots"
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={`More for ${label}`}
    title="More for this scene"
    onclick={toggle}>⋯</button
  >
  {#if open}
    <div class="menu" role="menu" tabindex="-1" bind:this={menu} onkeydown={onMenuKey}>
      <Button
        size="sm"
        variant="text"
        item
        role="menuitem"
        disabled={!editable || editing || approving}
        onclick={() => run(() => script.startEdit(beat))}>Edit the words <kbd>E</kbd></Button
      >
      <Button
        size="sm"
        variant="text"
        item
        role="menuitem"
        disabled={!editable || busy || editing || script.fixSending !== null}
        onclick={() => run(() => script.openFix(beat.id))}>Fix with a note… <kbd>F</kbd></Button
      >
      <Button
        size="sm"
        variant="text"
        item
        role="menuitem"
        disabled={!editable || busy}
        onclick={() => run(rewrite)}>Rewrite with Claude's options</Button
      >
      {#if isApproved(beat)}
        <Button
          size="sm"
          variant="text"
          item
          role="menuitem"
          disabled={approving}
          onclick={() => run(() => void script.decide(beat, 'clear'))}>Reopen for review</Button
        >
      {:else}
        <Button
          size="sm"
          variant="text"
          item
          role="menuitem"
          disabled={approving || busy || editing || cut}
          onclick={() => run(() => void script.decide(beat, 'ok'))}>OK this scene <kbd>Enter</kbd></Button
        >
      {/if}
      <Button
        size="sm"
        variant="text"
        item
        role="menuitem"
        disabled={!script.undoable[beat.id] || script.saving || approving}
        onclick={() => run(() => void script.undo(beat))}>Undo last save</Button
      >
      <hr />
      <Button size="sm" variant="text" item role="menuitem" onclick={() => void copy('words')}
        >{copied === 'words' ? 'Copied ✓' : 'Copy the narration'}</Button
      >
      <Button
        size="sm"
        variant="text"
        item
        role="menuitem"
        disabled={!beat.visual}
        onclick={() => void copy('screen')}
        >{copied === 'screen' ? 'Copied ✓' : 'Copy what is on screen'}</Button
      >
      <Button
        size="sm"
        variant="text"
        item
        role="menuitem"
        href={firstLine ? routeHref(`/voice?line=${encodeURIComponent(firstLine)}`) : undefined}
        disabled={!firstLine}>Hear it on Voice & music ›</Button
      >
    </div>
  {/if}
</div>

<style>
  .more {
    position: relative;
    flex-shrink: 0;
  }
  .dots {
    display: inline-grid;
    place-items: center;
    width: var(--h-sm);
    height: var(--h-sm);
    border: 1px solid transparent;
    border-radius: var(--r);
    background: none;
    color: var(--muted);
    font: 600 var(--t16) / 1 var(--body);
    cursor: pointer;
  }
  .dots:hover,
  .dots[aria-expanded='true'] {
    border-color: var(--line-2);
    color: var(--text);
  }
  .dots:focus-visible {
    outline: var(--focus);
    outline-offset: 1px;
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--s-4));
    left: 0;
    z-index: var(--z-menu);
    display: grid;
    min-width: max-content;
    gap: var(--s-2);
    padding: var(--s-4);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-3);
  }
  hr {
    margin: var(--s-2) 0;
    border: 0;
    border-top: 1px solid var(--line);
  }
  kbd {
    margin-left: auto;
    padding-left: var(--s-16);
    color: var(--faint);
    font: 600 var(--t12) / 1 var(--mono);
  }
</style>
