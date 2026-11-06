<!-- Writing: is Claude Code installed and signed in. Without it Mortiflix can't write. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { loginCommand } from '../../lib/setup/status';
  import SettingsSection from './SettingsSection.svelte';
  import type { SettingsPage } from './settings-page.svelte';

  interface Props {
    page: SettingsPage;
  }

  let { page }: Props = $props();
  const claude = $derived(page.status?.claude ?? {});
  const ready = $derived(page.writingReady);
  const details = $derived(
    [claude.version, claude.subscription && `${claude.subscription} plan`].filter(Boolean).join(' · '),
  );
</script>

<SettingsSection
  title="Writing"
  lede="Claude Code writes your scripts and looks. Without it Mortiflix can't write."
>
  {#if !page.status && page.statusError}
    <ErrorState
      inline
      title="Couldn't check Claude Code"
      detail={page.statusError}
      onretry={() => void page.recheck()}
    />
  {:else if !page.status}
    <LoadingState text="Checking Claude Code…" />
  {:else}
    <div class="line">
      <StatusMark
        size="md"
        mark={ready ? 'ok' : 'fix'}
        text={ready ? 'Connected' : claude.found ? 'Not signed in' : 'Not found'}
      />
      {#if ready && details}<span class="why">{details}</span>{/if}
      <Button size="sm" disabled={page.checking} onclick={() => void page.recheck()}>
        {page.checking ? 'Checking…' : 'Check again'}
      </Button>
    </div>
    {#if !ready}
      <p class="how">
        {#if claude.found}
          Open a terminal on this computer, run <code>{loginCommand(claude)}</code>, finish signing in, then
          press Check again.
        {:else}
          Install Claude Code from claude.com/claude-code, sign in once, then press Check again.
        {/if}
      </p>
    {/if}
  {/if}
</SettingsSection>

<style>
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8) var(--s-16);
    min-width: 0;
  }
  .why {
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .how {
    max-width: 70ch;
  }
  code {
    padding: var(--s-2) var(--s-8);
    border-radius: var(--r-sm);
    background: var(--ink-3);
    font: 400 var(--t14) / 1.4 var(--mono);
  }
</style>
