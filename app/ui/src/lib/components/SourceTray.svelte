<!-- The source tray: links and files for a project in one place, each with what became of it (reading, read, kept,
     failed) and a way to remove it. Files can be dropped on the box. The parent keeps the list and does the adding. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import AddSource from './AddSource.svelte';
  import SourceList from './SourceList.svelte';
  import { isInTray, type NewSource, type TraySource } from '../source-tray';

  interface Props {
    sources: readonly TraySource[];
    /** Adds a link or a file. A link it cannot add rejects with a plain sentence, shown under the box. */
    onadd: (source: NewSource) => Promise<void>;
    onremove: (id: string) => Promise<void>;
    /** Under the list, e.g. conflicts that touch the sources. */
    children?: Snippet;
  }

  let { sources, onadd, onremove, children }: Props = $props();

  const id = $props.id();
  let over = $state(false);
  let failed = $state('');
  let adding = $state<ReturnType<typeof AddSource>>();
  /** Puts the cursor in the link box (New project's "add a link" button), without looking it up by its label. */
  export const focusLink = (): void => adding?.focus();

  const reason = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

  async function addFiles(files: Iterable<File>) {
    failed = '';
    // Every file that failed is named, not only the last one.
    const notAdded: string[] = [];
    for (const file of files) {
      if (isInTray(file, sources)) continue;
      try {
        await onadd({ file });
      } catch (error) {
        notAdded.push(`${file.name} was not added: ${reason(error)}`);
      }
    }
    failed = notAdded.join(' · ');
  }

  async function remove(source: TraySource) {
    failed = '';
    try {
      await onremove(source.id);
      adding?.focus();
    } catch (error) {
      failed = `${source.label} was not removed: ${reason(error)}`;
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    over = false;
    void addFiles([...(event.dataTransfer?.files ?? [])]);
  }
</script>

<div
  class="tray"
  class:over
  role="group"
  aria-labelledby="{id}-title"
  ondragover={(event) => {
    event.preventDefault();
    over = true;
  }}
  ondragleave={() => (over = false)}
  ondrop={drop}
>
  <div class="head">
    <b id="{id}-title">Source material</b>
  </div>
  <AddSource bind:this={adding} {sources} {onadd} onfiles={(files) => void addFiles(files)} />
  {#if failed}<p class="failed" role="alert">! {failed}</p>{/if}
  {#if sources.length}
    <SourceList {sources} onremove={(source) => void remove(source)} />
  {/if}
  {@render children?.()}
</div>

<style>
  .tray {
    display: grid;
    gap: var(--s-12);
    padding: var(--s-16);
    border: 1px dashed var(--line-2);
    border-radius: var(--r);
  }
  .over {
    border-color: var(--text);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s-16);
  }
  .head b {
    font-weight: 600;
    white-space: nowrap;
  }
  .failed {
    color: var(--bad);
    font-size: var(--t13);
  }
</style>
