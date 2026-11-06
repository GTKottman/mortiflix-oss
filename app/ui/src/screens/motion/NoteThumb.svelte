<!-- The marked frame of a note, or the words that say it has none. -->
<script lang="ts">
  import { pictureUrl } from './media';
  import type { SceneNote } from './types';

  interface Props {
    note: SceneNote;
  }

  let { note }: Props = $props();
</script>

<div class="thumb" class:scene={!note.image}>
  {#if note.image}
    <img src={pictureUrl(note.image, 480)} alt="Your marks on the frame" loading="lazy" />
  {:else}
    <span>{note.kind === 'scene' ? 'Whole scene' : 'No frame'}</span>
  {/if}
</div>

<style>
  .thumb {
    position: relative;
    align-self: start;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--media);
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .scene {
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: var(--t12);
    white-space: nowrap;
  }
</style>
