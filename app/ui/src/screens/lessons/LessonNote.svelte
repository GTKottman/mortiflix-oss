<!-- What the owner said about a lesson: the frame they marked and their words, with where it was. -->
<script lang="ts">
  import { thumbUrl } from '../../lib/files';
  import { noteLine } from './lessons';
  import type { Lesson } from './types';

  interface Props {
    lesson: Lesson;
  }

  let { lesson }: Props = $props();
  const image = $derived(lesson.source?.image);
  const said = $derived(noteLine(lesson));

  const PICTURE_PX = 640;
</script>

{#if image}
  <div class="frame">
    <img src={thumbUrl(image, PICTURE_PX)} alt="The frame you marked" loading="lazy" decoding="async" />
  </div>
{/if}
{#if said}<p class="said">{said}</p>{/if}

<style>
  .frame {
    --picture-w: 320px;
    width: min(var(--picture-w), 100%);
    aspect-ratio: 16 / 9;
    margin-top: var(--s-8);
    overflow: hidden;
    border-radius: var(--r);
    background: var(--ink-4);
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .said {
    margin-top: var(--s-8);
    padding: var(--s-8) 0 var(--s-8) var(--s-12);
    border-left: 2px solid var(--line-2);
    color: var(--muted);
    font-size: var(--t14);
  }
</style>
