<!-- The file's name and Copy path. When the clipboard is refused the path is shown selected, to copy by hand. -->
<script lang="ts">
  import { tick } from 'svelte';
  import LinkButton from '../../lib/components/LinkButton.svelte';
  import { fileName } from './finish';

  interface Props {
    path: string;
  }

  let { path }: Props = $props();

  const COPIED_MS = 3000;
  let message = $state('');
  let manual = $state(false);
  let shown = $state<HTMLElement>();

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      manual = false;
      message = 'Path copied.';
      setTimeout(() => {
        if (message === 'Path copied.') message = '';
      }, COPIED_MS);
    } catch {
      manual = true;
      message = '';
      await tick();
      if (!shown) return;
      const range = document.createRange();
      range.selectNodeContents(shown);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
</script>

<section aria-labelledby="file-h">
  <h2 id="file-h">File details</h2>
  <div class="row">
    <span class="name" title={path}>{fileName(path)}</span>
    <LinkButton onclick={copy}>Copy path</LinkButton>
  </div>
  <p class="note" role="status">
    {#if manual}Copy this path: <span class="mono" bind:this={shown}>{path}</span>{:else}{message}{/if}
  </p>
</section>

<style>
  section {
    display: grid;
    gap: var(--s-12);
    min-width: 0;
  }
  h2 {
    color: var(--faint);
    font: 600 var(--t12) / 1.2 var(--body);
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-12);
  }
  .name,
  .mono {
    font: 400 var(--t13) / 1.4 var(--mono);
    overflow-wrap: anywhere;
    word-break: break-all;
  }
  .mono {
    user-select: all;
  }
  .note {
    color: var(--muted);
    font-size: var(--t13);
    overflow-wrap: anywhere;
  }
  .note:empty {
    display: none;
  }
</style>
