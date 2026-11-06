<!-- The one picture in review, as large as the room above the buttons allows, with a tag for its state,
     "Look at: …" and the version switch (v1 v2). Not made yet: says why, in words. -->
<script lang="ts">
  import { fileUrl } from '../files';
  import type { ReviewItem } from '../review/types';
  import Button from './Button.svelte';

  interface Props {
    item: ReviewItem;
    /** An older version being looked at; null = the newest. */
    version: number | null;
    onversion: (version: number | null) => void;
    /** What to say where the picture will be, while there is none. */
    placeholder: { title: string; body: string };
  }

  let { item, version, onversion, placeholder }: Props = $props();

  const shown = $derived(item.versions.find((entry) => entry.v === version) ?? null);
  const path = $derived(shown?.path ?? item.path);
  const older = $derived(shown !== null && shown.v !== item.version);
  const tag = $derived.by(() => {
    if (item.state === 'making' && item.waitWords?.startsWith('Fix kept'))
      return { look: 'warn', text: '• Fix kept, not sent yet' };
    if (item.state === 'making') return { look: 'busy', text: '◌ Being made again' };
    if (older) return { look: 'warn', text: `Older version ${shown?.v}` };
    if (item.state === 'held') return { look: 'warn', text: '! Held' };
    if (item.state === 'ok') return { look: 'good', text: '✓ OK' };
    return null;
  });
</script>

<div class="shot">
  <div
    class="screen"
    class:held={item.state === 'held'}
    role="group"
    aria-label={`${item.label}${path ? '' : ', not ready'}`}
  >
    {#if path}
      <img src={fileUrl(path)} alt={`${item.label}${item.lookAt ? '. ' + item.lookAt : ''}`} />
      {#if tag}<span class="tag {tag.look}">{tag.text}</span>{/if}
    {:else}
      <div class="busy-note" role="status">
        <b>{placeholder.title || 'Not made yet'}</b>
        {#if placeholder.body}<span>{placeholder.body}</span>{/if}
      </div>
    {/if}
  </div>
  <div class="under">
    <span class="lookat"
      >{#if item.lookAt}<b>Look at:</b> {item.lookAt}{/if}</span
    >
    {#if item.versions.length > 1}
      <span class="vers" role="group" aria-label="Versions">
        Versions
        {#each item.versions as entry (entry.v)}
          <Button
            size="sm"
            pressed={(shown ? shown.v : item.version) === entry.v}
            onclick={() => onversion(entry.v === item.version ? null : entry.v)}>v{entry.v}</Button
          >
        {/each}
      </span>
    {/if}
  </div>
</div>

<style>
  .shot {
    width: min(100%, calc((100vh - var(--review-chrome-h)) * 16 / 9));
    min-width: var(--review-picture-min-w);
  }
  .screen {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-lg);
    background: var(--media);
    border: 1px solid var(--line);
    overflow: hidden;
  }
  .screen.held {
    border-color: var(--warn);
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: var(--media);
  }
  .busy-note {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--s-8);
    padding: var(--s-24);
    color: var(--muted);
    text-align: center;
  }
  .busy-note b {
    color: var(--text);
    font: 600 var(--t16) / 1.3 var(--body);
  }
  .tag {
    position: absolute;
    left: var(--s-12);
    top: var(--s-12);
    padding: var(--s-4) var(--s-8);
    border-radius: var(--r-sm);
    background: var(--ink);
    font-size: var(--t12);
    font-weight: 600;
    white-space: nowrap;
  }
  .warn {
    color: var(--warn);
  }
  .good {
    color: var(--good);
  }
  .busy {
    color: var(--busy);
  }
  .under {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s-12);
    min-height: var(--h-sm);
    margin-top: var(--s-12);
    color: var(--muted);
    font-size: var(--t13);
  }
  .lookat b {
    color: var(--text);
    font-weight: 600;
  }
  .vers {
    display: inline-flex;
    flex-wrap: wrap;
    white-space: nowrap;
    align-items: center;
    gap: var(--s-4);
  }
  @media (max-width: 1199px) {
    .shot {
      width: 100%;
    }
  }
</style>
