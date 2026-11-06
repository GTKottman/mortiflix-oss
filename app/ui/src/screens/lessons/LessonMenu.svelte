<!-- A lesson's ⋯ menu: every action for it in one place. Edit, copy the words, move it to another section, use it
     in every project or only in the one its note came from, switch it on or off, show its note, delete it (asks
     first, Keep is focused; Undo shows above the list). -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import MoreMenu from '../../lib/components/MoreMenu.svelte';
  import { useProject } from '../../lib/stores/context';
  import { clip, hasNote, isOn, lessonName, SECTIONS, sourceProject } from './lessons';
  import type { LessonsView } from './lessons.svelte';
  import type { Lesson, LessonScope } from './types';

  interface Props {
    lesson: Lesson;
    view: LessonsView;
  }

  let { lesson, view }: Props = $props();

  const NAME_CHARS = 40;

  let open = $state(false);
  let asking = $state(false);
  let busy = $state(false);
  let said = $state('');
  let menu = $state<ReturnType<typeof MoreMenu>>();

  const on = $derived(isOn(lesson));
  const moves = $derived(SECTIONS.filter((section) => section !== lesson.section));
  const openProject = useProject();
  /** Only-one-project lessons live in the project their note came from. */
  const home = $derived(lesson.source?.project_title ?? (openProject.title || sourceProject(lesson)));
  const scopeMove = $derived.by((): { to: LessonScope; label: string } | null => {
    if (!lesson.approved) return null;
    if (lesson.scope === 'project') return { to: 'all', label: 'Every project' };
    return home ? { to: 'project', label: `Only in ${clip(home, NAME_CHARS)}` } : null;
  });

  $effect(() => {
    if (open) return;
    asking = false;
    said = '';
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(lesson.text);
      said = 'Words copied.';
    } catch {
      said = 'Could not copy: the browser did not allow it.';
    }
  }

  async function act(work: () => Promise<void>, close: (refocus: boolean) => void, failed: string) {
    busy = true;
    try {
      await work();
    } catch (error) {
      view.notice = `${failed}: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      busy = false;
      close(true);
    }
  }

  function remove(close: (refocus: boolean) => void) {
    if (!asking) {
      asking = true;
      void menu?.focusFirst();
      return;
    }
    void act(() => view.remove(lesson), close, 'Could not delete that lesson');
  }
</script>

<MoreMenu bind:this={menu} bind:open label={`More for the lesson ${lessonName(lesson)}`}>
  {#snippet children(close)}
    {#if asking}
      <p class="words">Delete this lesson? Undo brings it back. Switch it off instead to keep it.</p>
      <Button item role="menuitem" onclick={() => close(true)}>Keep it</Button>
      <Button item variant="danger" role="menuitem" disabled={busy} onclick={() => remove(close)}
        >{busy ? 'Deleting…' : 'Delete it'}</Button
      >
    {:else}
      <Button
        item
        role="menuitem"
        onclick={() => {
          close(false);
          view.editing = lesson.id;
        }}>Edit</Button
      >
      <Button item role="menuitem" onclick={() => void copy()}>Copy words</Button>
      {#if hasNote(lesson)}
        <Button
          item
          role="menuitem"
          onclick={() => {
            close(true);
            view.toggleNote(lesson.id);
          }}>{view.noteOpen === lesson.id ? 'Hide note' : 'Show note'}</Button
        >
      {/if}
      {#if lesson.approved}
        <Button
          item
          role="menuitem"
          disabled={busy}
          onclick={() => void act(() => view.toggle(lesson, !on), close, 'Could not save that')}
          >{on ? 'Switch off' : 'Switch on'}</Button
        >
      {/if}
      <hr />
      <span class="label">Move to</span>
      {#each moves as section (section)}
        <Button
          item
          role="menuitem"
          disabled={busy}
          onclick={() =>
            void act(() => view.save(lesson, lesson.text, section), close, 'Could not move that lesson')}
          >{section}</Button
        >
      {/each}
      {#if scopeMove}
        <hr />
        <span class="label">Use in</span>
        <Button
          item
          role="menuitem"
          disabled={busy}
          onclick={() =>
            void act(() => view.moveScope(lesson, scopeMove.to), close, 'Could not move that lesson')}
          >{scopeMove.label}</Button
        >
      {/if}
      <hr />
      <Button item variant="danger" role="menuitem" onclick={() => remove(close)}>Delete…</Button>
      {#if said}<p class="words" role="status">{said}</p>{/if}
    {/if}
  {/snippet}
</MoreMenu>

<style>
  .label {
    padding: var(--s-8) var(--s-12) var(--s-4);
    color: var(--faint);
    font: 600 var(--t11) / 1 var(--body);
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .words {
    padding: var(--s-8) var(--s-12);
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
