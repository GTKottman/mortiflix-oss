<!-- A project's first still, 16:9 with a hairline edge. No badge on top. -->
<script lang="ts">
  import { thumbUrl } from '../../lib/files';
  import type { Still } from './types';

  interface Props {
    still?: Still;
  }

  let { still }: Props = $props();
  const src = $derived(still ? (typeof still === 'object' ? still.url : thumbUrl(still)) : null);
</script>

{#if src}
  <div class="picture"><img {src} alt="" loading="lazy" decoding="async" /></div>
{:else}
  <div class="picture" role="img" aria-label="No still yet">No still yet</div>
{/if}

<style>
  .picture {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--ink-2);
    color: var(--faint);
    font-size: var(--t13);
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
