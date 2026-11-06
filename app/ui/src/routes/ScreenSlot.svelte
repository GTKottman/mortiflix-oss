<!-- Shows the route's screen: the one in src/screens/<folder>/ when it exists, else a stub that links to
     today's page. A screen is loaded the first time it is opened; a chunk gone after a new build reloads the
     page once (chunk-reload.ts), and if it still fails the error offers Reload. -->
<script lang="ts">
  import Button from '../lib/components/Button.svelte';
  import ErrorState from '../lib/components/ErrorState.svelte';
  import LoadingState from '../lib/components/LoadingState.svelte';
  import { isChunkLoadError, loadWithReload } from './chunk-reload';
  import { screenFor } from './routes';
  import ScreenStub from './ScreenStub.svelte';

  interface Props {
    folder: string;
    kicker: string;
    title: string;
  }

  let { folder, kicker, title }: Props = $props();
  const load = $derived(screenFor(folder));
</script>

{#if load}
  {#await loadWithReload(load)}
    <LoadingState />
  {:then screen}
    <screen.default />
  {:catch error}
    <ErrorState
      title="Could not open this screen"
      detail={isChunkLoadError(error)
        ? 'Mortiflix was updated while this tab was open. Reload to get the new version.'
        : error instanceof Error
          ? error.message
          : String(error)}
    />
    <div><Button size="sm" onclick={() => location.reload()}>Reload</Button></div>
  {/await}
{:else}
  <ScreenStub {kicker} {title} oldPage={folder} />
{/if}
