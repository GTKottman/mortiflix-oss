<!-- The addresses to open on the tablet (or, for Home network, on another device), each with whether it answers
     (when that was checked) and a Copy button. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import type { TabletAddress } from './types';
  import { labelled } from './video-notes';

  interface Props {
    addresses: readonly TabletAddress[];
    title?: string;
    /** Shown when there is no address. */
    empty?: string;
  }

  let {
    addresses,
    title = 'Open one of these on your tablet',
    empty = 'No address found yet. Connect the tablet to your home Wi-Fi or Tailscale, then press Check again.',
  }: Props = $props();
  const rows = $derived(labelled(addresses));
  let copied = $state<string | null>(null);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      copied = url;
    } catch {
      copied = `select:${url}`;
    }
  }
</script>

<div class="two">
  <b>{title}</b>
  {#if rows.length}
    <div class="addresses">
      {#each rows as { label, address } (address.url)}
        <span class="kind">{label}</span>
        <span class="url">{address.url}</span>
        <span class="state">
          {#if address.reachable !== undefined}
            <StatusMark
              mark={address.reachable === false ? 'fix' : 'ok'}
              text={address.reachable === false ? 'not answering' : 'answers'}
            />
          {/if}
        </span>
        <Button size="sm" variant="text" onclick={() => copy(address.url)}>
          {copied === address.url
            ? 'Copied'
            : copied === `select:${address.url}`
              ? 'Select it to copy'
              : 'Copy'}
        </Button>
      {/each}
    </div>
  {:else}
    <span>{empty}</span>
  {/if}
</div>

<style>
  .two {
    display: grid;
    gap: var(--s-4);
    max-width: 70ch;
    color: var(--muted);
  }
  b {
    color: var(--text);
    font-weight: 600;
  }
  .addresses {
    --kind-w: 150px;
    display: grid;
    grid-template-columns: var(--kind-w) minmax(0, 1fr) auto auto;
    gap: var(--s-8) var(--s-16);
    align-items: center;
  }
  .kind,
  .state {
    white-space: nowrap;
  }
  .url {
    overflow-wrap: anywhere;
    user-select: all;
    font: 400 var(--t14) / 1.4 var(--mono);
    color: var(--text);
  }
  @media (max-width: 1199px) {
    .addresses {
      --kind-w: 110px;
    }
  }
</style>
