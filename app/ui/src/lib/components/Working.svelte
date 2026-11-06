<!-- Honest busy words: "Mortiflix is doing it… 12 s", the time counting from when it appeared. -->
<script lang="ts">
  import Elapsed from './Elapsed.svelte';

  interface Props {
    text: string;
  }

  let { text }: Props = $props();
  const since = Date.now();
</script>

<span class="working" role="status"
  ><span class="glyph" aria-hidden="true">◌</span>{text}<span class="time"><Elapsed {since} /></span></span
>

<style>
  .working {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--s-8);
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .glyph {
    color: var(--busy);
  }
  .time {
    color: var(--faint);
  }
</style>
