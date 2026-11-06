<!-- Two settings that disagree, in plain words, with the fixes the service offers and "Keep it as is". -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { useNewProject } from './context';
  import type { Conflict } from './types';

  interface Props {
    conflict: Conflict;
  }

  let { conflict }: Props = $props();
  const { form, live } = useNewProject();
</script>

<div class="conflict" role="note">
  <b>{conflict.text}</b>
  <div class="fixes">
    {#each conflict.resolutions ?? [] as fix (fix.text)}
      <Button
        size="sm"
        onclick={() => {
          for (const [path, value] of Object.entries(fix.set)) form.setByPath(path, value);
        }}>{fix.text}</Button
      >
    {/each}
    <Button size="sm" variant="text" onclick={() => live.keep(conflict)}>Keep it as is</Button>
  </div>
</div>

<style>
  .conflict {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-8) 0 var(--s-8) var(--s-12);
    border-left: 2px solid var(--warn);
    font-size: var(--t13);
  }
  b::before {
    content: '! ';
    color: var(--warn);
  }
  .fixes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-8);
  }
</style>
