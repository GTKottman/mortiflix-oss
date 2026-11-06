<!-- The picked file, shown as it is on disk, with its download. Text comes through the service (project.file.read):
     the bridge's /file serves media only. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { fileUrl } from '../../lib/files';
  import { useProject, useService } from '../../lib/stores/context';
  import type { Viewed } from './types';

  interface Props {
    item: Viewed;
  }

  let { item }: Props = $props();
  const client = useService();
  const project = useProject();

  /** A long file shows its start; the download always has all of it. */
  const SHOWN_CHARS = 200_000;
  let text = $state<string | null>(null);
  let problem = $state('');

  const name = $derived(item.path.split('/').pop() ?? 'file');
  const media = $derived(item.kind === 'image' || item.kind === 'audio' || item.kind === 'video');

  $effect(() => {
    const { kind, path } = item;
    text = null;
    problem = '';
    if (kind !== 'text') return;
    let current = true;
    client.call<{ text: string }>('project.file.read', { project: project.id, path }).then(
      (read) => {
        if (current) text = read.text;
      },
      (error: unknown) => {
        if (current) problem = error instanceof Error ? error.message : 'Could not read that file.';
      },
    );
    return () => {
      current = false;
    };
  });

  function saveText() {
    if (text === null) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
  }
</script>

<section class="viewer" aria-label="Picked file">
  <header>
    <b title={item.title}>{item.title}</b>
    {#if media}
      <Button size="sm" href={fileUrl(item.path)} download={name}>Download</Button>
    {:else if item.kind === 'text'}
      <Button size="sm" disabled={text === null} onclick={saveText}>Download</Button>
    {/if}
  </header>
  {#if problem}
    <p class="note">{problem}</p>
  {:else if item.kind === 'image'}
    <img src={fileUrl(item.path)} alt={name} />
  {:else if item.kind === 'audio'}
    <audio src={fileUrl(item.path)} controls></audio>
  {:else if item.kind === 'video'}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video src={fileUrl(item.path)} controls></video>
  {:else if item.kind === 'text'}
    {#if text === null}
      <p class="note">Reading…</p>
    {:else}
      {#if text.length > SHOWN_CHARS}<p class="note">Showing the start. Download has the whole file.</p>{/if}
      <pre>{text.slice(0, SHOWN_CHARS)}</pre>
    {/if}
  {:else}
    <p class="note">This kind of file can't be shown here.</p>
  {/if}
</section>

<style>
  .viewer {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: var(--s-12);
    min-width: 0;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-12);
    min-width: 0;
  }
  b {
    overflow: hidden;
    color: var(--text);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  img,
  video {
    max-width: 100%;
    max-height: 70vh;
    border-radius: var(--r);
    background: var(--ink-2);
  }
  audio {
    width: 100%;
  }
  pre {
    overflow: auto;
    max-height: 70vh;
    margin: 0;
    padding: var(--s-12);
    border-radius: var(--r);
    background: var(--ink-2);
    color: var(--muted);
    font: var(--t12) / 1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .note {
    margin: 0;
    color: var(--muted);
  }
</style>
