<!-- Home network (optional, off by default): let other devices on the home network use Mortiflix Studio. The switch
     applies at once (the bridge listens again) and can only be changed on this computer. When it is on: the addresses
     to open and what that allows. -->
<script lang="ts">
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import Switch from '../../lib/components/Switch.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import type { SettingsPage } from './settings-page.svelte';
  import TabletAddresses from './TabletAddresses.svelte';

  interface Props {
    page: SettingsPage;
  }

  let { page }: Props = $props();
  const lan = $derived(page.lan);
  /** This page is open on the computer the studio runs on (the bridge refuses the change from anywhere else). */
  const here = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  const label = 'Let devices on my home network use Mortiflix Studio';
</script>

<SettingsSection title="Home network" lede="Optional. Use Mortiflix Studio from another computer, tablet or phone at home.">
  {#if !lan}
    {#if page.accessError}
      <ErrorState
        inline
        title="Couldn't read this"
        detail={page.accessError}
        onretry={() => void page.loadAccess()}
      />
    {:else}
      <LoadingState text="Reading the setting…" />
    {/if}
  {:else}
    <div class="switch">
      <Switch
        controlled
        hideLabel
        checked={lan.enabled}
        {label}
        disabled={page.lanBusy || lan.forced || !here}
        onchange={(enabled) => void page.setLan(enabled)}
      />
      <div class="two">
        <span class="label">{label}</span>
        {#if page.lanBusy}
          <StatusMark mark="busy" text={lan.enabled ? 'Turning it off…' : 'Turning it on…'} />
        {/if}
        <span class="warn">Anyone on that network can then use Claude Code and spend your credits.</span>
        {#if lan.forced}
          <span class="why">On because Mortiflix Studio was started with MFX_BRIDGE_LAN=1 (tools/serve-lan.sh).</span>
        {:else if !here}
          <span class="why">This can only be changed on the computer Mortiflix Studio runs on.</span>
        {/if}
      </div>
    </div>
    {#if page.lanError}
      <p role="alert"><StatusMark mark="fix" text={page.lanError} /></p>
    {/if}
    {#if lan.enabled}
      <TabletAddresses
        addresses={lan.addresses}
        title="Open one of these on the other device"
        empty="No home-network address found on this computer. Connect it to your home network, then open Settings again."
      />
    {/if}
  {/if}
</SettingsSection>

<style>
  .switch {
    display: flex;
    align-items: flex-start;
    gap: var(--s-16);
  }
  .two {
    display: grid;
    gap: var(--s-4);
    max-width: 70ch;
    color: var(--muted);
  }
  .label {
    color: var(--text);
    font: 600 var(--t16) / 1.3 var(--body);
  }
  .warn {
    color: var(--warn);
  }
  .why {
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
