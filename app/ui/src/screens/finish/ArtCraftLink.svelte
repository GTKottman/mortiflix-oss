<!-- The quiet way into ArtCraft for changes by hand. It never competes with Download. It asks first: opening writes a
     new ArtCraft project over the last one, so hand edits made there would be lost (artcraft.mjs). -->
<script lang="ts">
  import LinkButton from '../../lib/components/LinkButton.svelte';
  import { isNotBuiltYet } from '../../lib/service/client';
  import { ARTCRAFT_REBUILDS } from './finish';

  interface Props {
    open: () => Promise<void>;
  }

  let { open }: Props = $props();
  let message = $state('');
  let busy = $state(false);
  let asking = $state(false);

  async function openIt() {
    if (busy) return;
    asking = false;
    busy = true;
    message = 'Writing the file…';
    try {
      await open();
      message = 'Opened in ArtCraft.';
    } catch (error) {
      message = isNotBuiltYet(error)
        ? 'Not available in this build yet.'
        : error instanceof Error
          ? error.message
          : 'Could not open ArtCraft.';
    }
    busy = false;
  }
</script>

<p class="extra">
  Need changes?
  {#if asking}
    <span>{ARTCRAFT_REBUILDS}</span>
    <LinkButton onclick={openIt}>Open in ArtCraft ↗</LinkButton>
    <LinkButton onclick={() => (asking = false)}>Keep the last one</LinkButton>
  {:else}
    <LinkButton disabled={busy} onclick={() => {
        asking = true;
        message = '';
      }}>Open in ArtCraft ↗</LinkButton>
  {/if}
  <span role="status">{message}</span>
</p>

<style>
  .extra {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s-8);
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
