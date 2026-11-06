<!-- The spoken line this still is for, with the key word marked. -->
<script lang="ts">
  interface Props {
    words: string;
    keyWord?: string;
  }

  let { words, keyWord }: Props = $props();

  const at = $derived(keyWord ? words.toLowerCase().indexOf(keyWord.toLowerCase()) : -1);
</script>

<p class="say">
  {#if keyWord && at >= 0}{words.slice(0, at)}<em>{words.slice(at, at + keyWord.length)}</em>{words.slice(
      at + keyWord.length,
    )}{:else}{words}{/if}
</p>

<style>
  .say {
    max-width: 60ch;
    font-size: var(--t17);
    line-height: 1.4;
  }
  em {
    font-style: normal;
    background: var(--ink-4);
    border-radius: 4px;
    padding: 0 var(--s-4);
    text-decoration: underline 2px var(--line-2);
    text-underline-offset: 3px;
  }
</style>
