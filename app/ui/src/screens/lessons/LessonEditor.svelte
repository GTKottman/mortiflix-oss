<!-- Edit a lesson: its name, its words and its section. Ctrl+Enter saves. Delete asks first. A failure shows here, in place. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import ConfirmInline from '../../lib/components/ConfirmInline.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import { SECTIONS } from './lessons';
  import type { Lesson } from './types';

  interface Props {
    lesson: Lesson;
    onsave: (text: string, section: string, name: string) => Promise<void>;
    onremove: () => Promise<void>;
    oncancel: () => void;
  }

  let { lesson, onsave, onremove, oncancel }: Props = $props();

  // The first values are the starting point of the edit; the lesson itself changes only on Save.
  // svelte-ignore state_referenced_locally
  let name = $state(lesson.name ?? '');
  // svelte-ignore state_referenced_locally
  let text = $state(lesson.text);
  // svelte-ignore state_referenced_locally
  let section = $state(lesson.section);
  let failure = $state<{ title: string; detail: string; retry: () => void } | null>(null);
  /** A save or delete is on its way: a second press (or Ctrl+Enter) waits for it. */
  let busy = $state(false);
  /** The service keeps up to this many characters of a lesson (svc/lessons.mjs editLesson). */
  const MAX_CHARS = 600;
  const MAX_NAME = 60;
  let box = $state<HTMLTextAreaElement>();
  const sections = $derived(SECTIONS.some((s) => s === section) ? SECTIONS : [section, ...SECTIONS]);

  onMount(() => box?.focus());

  const reason = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

  async function save() {
    if (busy) return;
    busy = true;
    failure = null;
    try {
      await onsave(text, section, name);
    } catch (error) {
      failure = { title: 'Could not save that', detail: reason(error), retry: () => void save() };
    }
    busy = false;
  }

  async function remove() {
    if (busy) return;
    busy = true;
    failure = null;
    try {
      await onremove();
    } catch (error) {
      failure = { title: 'Could not delete', detail: reason(error), retry: () => void remove() };
    }
    busy = false;
  }

  function keydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  }
</script>

<div class="edit">
  <input bind:value={name} maxlength={MAX_NAME} aria-label="Lesson name" placeholder="Name" onkeydown={keydown} />
  <textarea
    bind:this={box}
    bind:value={text}
    maxlength={MAX_CHARS}
    aria-label="Lesson words"
    onkeydown={keydown}
  ></textarea>
  <div class="actions">
    <select bind:value={section} aria-label="Section">
      {#each sections as name (name)}<option value={name}>{name}</option>{/each}
    </select>
    <Button size="sm" disabled={busy} onclick={save}>Save</Button>
    <Button size="sm" onclick={oncancel}>Cancel</Button>
    <ConfirmInline
      label="Delete this lesson"
      question="Delete it? You can undo this."
      yes="Delete"
      no="Keep"
      variant="danger"
      onyes={remove}
    />
  </div>
  <span class="hint">Ctrl+Enter saves. {text.length} of {MAX_CHARS} characters.</span>
  {#if failure}<ErrorState
      inline
      title={failure.title}
      detail={failure.detail}
      onretry={failure.retry}
    />{/if}
</div>

<style>
  .edit {
    display: grid;
    gap: var(--s-8);
  }
  textarea {
    width: 100%;
    min-height: calc(var(--s-32) * 2.25);
    padding: var(--s-8) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    resize: vertical;
  }
  input {
    width: 100%;
    height: var(--h);
    padding: 0 var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    font-weight: 600;
  }
  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible {
    outline: none;
    border-color: var(--link);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
  select {
    width: fit-content;
    max-width: 100%;
    height: var(--h);
    padding: 0 var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
  }
  .hint {
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
