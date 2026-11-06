<!-- Video Notes on the tablet (optional): review each scene on the tablet and mark it up with the pen. The switch
     applies at once. When it is on: the addresses to open, whether the tablet has checked in, and what is wrong. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import Switch from '../../lib/components/Switch.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import type { SettingsPage } from './settings-page.svelte';
  import TabletAddresses from './TabletAddresses.svelte';
  import { ago, folderWords } from './video-notes';

  interface Props {
    page: SettingsPage;
  }

  let { page }: Props = $props();
  const notes = $derived(page.videoNotes);
  let checking = $state(false);

  async function checkAgain() {
    checking = true;
    await page.loadVideoNotes();
    checking = false;
  }
</script>

<SettingsSection
  title="Video Notes on your tablet"
  lede="Optional. Look at each scene on your tablet and mark it up with the pen."
>
  {#if page.videoNotesSoon}
    <EmptyState
      title="Arrives in this build"
      body="Review each scene on your tablet. This switch appears here once Video Notes is built in."
    />
  {:else if !notes}
    {#if page.videoNotesError}
      <ErrorState
        inline
        title="Couldn't check Video Notes"
        detail={page.videoNotesError}
        onretry={() => void page.loadVideoNotes()}
      />
    {:else}
      <LoadingState text="Checking Video Notes…" />
    {/if}
  {:else}
    <div class="switch">
      <Switch
        controlled
        hideLabel
        checked={notes.enabled}
        label="Review scenes on my tablet with Video Notes"
        disabled={page.videoNotesBusy}
        onchange={(enabled) => void page.setVideoNotes(enabled)}
      />
      <div class="two">
        <span class="label">Review scenes on my tablet with Video Notes</span>
        {#if page.videoNotesBusy}
          <StatusMark mark="busy" text={notes.enabled ? 'Turning it off…' : 'Turning it on…'} />
        {/if}
        <span>When this is on, each scene ready for review goes to your tablet.</span>
        <span>OK with notes remakes that scene. OK with no notes makes the next one.</span>
        {#if !notes.enabled}
          <span class="why">Needs the tablet on your home Wi-Fi, or Tailscale when you are away.</span>
        {/if}
        {#if page.firstRun}
          <span class="why"
            >{notes.enabled ? 'You can turn this off later.' : 'You can turn this on later.'}</span
          >
        {/if}
      </div>
    </div>
    {#if page.videoNotesError}
      <p role="alert"><StatusMark mark="fix" text={page.videoNotesError} /></p>
    {/if}
    {#if notes.enabled}
      <TabletAddresses addresses={notes.addresses ?? []} />
      <div class="line">
        {#if notes.tablet_seen}
          <StatusMark size="md" mark="ok" text={`Your tablet checked in ${ago(notes.tablet_seen)}`} />
        {:else}
          <StatusMark size="md" mark="wait" text="Your tablet hasn't checked in yet" />
          <span class="why">Open Video Notes on it and it shows here.</span>
        {/if}
      </div>
      {#if notes.problems?.length}
        <div class="problems" role="status">
          {#each notes.problems as problem (problem)}<p>{problem}</p>{/each}
        </div>
      {/if}
      <div class="line">
        <Button size="sm" disabled={checking} onclick={checkAgain}
          >{checking ? 'Checking…' : 'Check again'}</Button
        >
        {#if notes.folder}
          <span class="why" title={notes.folder}>Videos wait in {folderWords(notes.folder)}</span>
        {/if}
      </div>
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
  .why {
    color: var(--muted);
    font-size: var(--t13);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8) var(--s-16);
  }
  .problems {
    display: grid;
    gap: var(--s-8);
  }
  .problems p {
    color: var(--warn);
  }
  .problems p::before {
    content: '! ';
  }
</style>
