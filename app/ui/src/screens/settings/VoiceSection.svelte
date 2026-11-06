<!-- Voice: the ElevenLabs key (saved on this computer and never shown again) and the optional daily credit cap. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import ConfirmInline from '../../lib/components/ConfirmInline.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import type { SettingsPage } from './settings-page.svelte';

  interface Props {
    page: SettingsPage;
    /** Scroll here and put the cursor in the key box once the key is known (Home's "Add key"). */
    focusKey?: boolean;
  }

  let { page, focusKey = false }: Props = $props();

  let value = $state('');
  let replacing = $state(false);
  let missing = $state<string | null>(null);
  let section = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();
  let focused = false;

  const asking = $derived(!page.voiceKeySet || replacing);

  // The daily credit cap box: what is saved, until the owner types (empty = no cap).
  let capValue = $state<number | null>(null);
  let capMissing = $state<string | null>(null);
  // copied in only when the saved cap itself changes: settings.changed fires for every setting, and what the owner is
  // typing must not be wiped by an unrelated change
  let lastSavedCap: number | null | undefined = undefined;
  $effect(() => {
    const saved = page.cap?.daily_cap ?? null;
    if (saved !== lastSavedCap) {
      lastSavedCap = saved;
      capValue = saved;
    }
  });
  const credits = (n: number): string => Math.round(n).toLocaleString('en-US');

  async function saveCap() {
    if (page.capBusy) return;
    const cap = capValue === null || capValue === 0 ? null : capValue;
    if (cap !== null && (!Number.isInteger(cap) || cap < 1)) {
      capMissing = 'A whole number of credits, or empty for no cap.';
      return;
    }
    capMissing = null;
    await page.setCap(cap);
  }

  function capKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') void saveCap();
  }

  $effect(() => {
    if (!focusKey || focused || !page.keysLoaded) return;
    focused = true;
    void tick().then(() => {
      section?.scrollIntoView();
      input?.focus();
    });
  });

  async function save() {
    if (page.keyBusy) return;
    const key = value.trim();
    if (!key) {
      missing = 'Paste the key first.';
      return;
    }
    missing = null;
    if (await page.saveKey(key)) {
      replacing = false;
      value = '';
    }
  }

  async function replace() {
    replacing = true;
    await tick();
    input?.focus();
  }

  function cancel() {
    replacing = false;
    value = '';
    missing = null;
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter') void save();
  }
</script>

<SettingsSection
  bind:element={section}
  title="Voice"
  lede="ElevenLabs reads your script, makes the music and the sounds. It is the only voice Mortiflix makes."
>
  {#if page.keysFailed}
    <ErrorState
      inline
      title="Couldn't read the key"
      detail={page.keysFailed}
      onretry={() => void page.loadKeys()}
    />
  {:else if !page.keysLoaded}
    <LoadingState text="Reading the key…" />
  {:else}
    <div class="line">
      <StatusMark
        size="md"
        mark={page.voiceKeySet ? 'ok' : 'wait'}
        text={page.voiceKeySet ? 'Key saved' : 'No key yet'}
      />
      {#if page.voiceKeySet && !replacing}
        <Button size="sm" onclick={replace}>Replace</Button>
        <ConfirmInline
          label="Remove"
          question="Remove the key?"
          yes="Remove"
          no="Keep"
          onyes={() => page.removeKey()}
        />
      {/if}
    </div>
    {#if !page.voiceKeySet}
      <p class="need">
        No ElevenLabs key is saved, so nothing is spoken and no music or sounds are made. Paste a key below.
        Scripts, looks and stills still work.
      </p>
    {/if}
    {#if asking}
      <div class="keyrow">
        <input
          bind:this={input}
          bind:value
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="Paste your ElevenLabs key"
          aria-label="ElevenLabs key"
          onkeydown={keydown}
        />
        <Button disabled={page.keyBusy !== null} onclick={save}
          >{page.keyBusy === 'save' ? 'Saving…' : 'Save key'}</Button
        >
        {#if replacing}<Button variant="text" onclick={cancel}>Cancel</Button>{/if}
      </div>
      <p class="why">It is stored on this computer and never shown again.</p>
    {/if}
    {#if page.voiceKeySet && page.keyCheck}
      <p role={page.keyCheck.ok === false ? 'alert' : 'status'}>
        <StatusMark
          mark={page.keyCheck.ok === true ? 'ok' : page.keyCheck.ok === false ? 'fix' : 'wait'}
          text={page.keyCheck.ok === true ? `ElevenLabs accepted it: ${page.keyCheck.detail}` : page.keyCheck.detail}
        />
      </p>
    {/if}
    {#if missing || page.keyError}
      <p role="alert"><StatusMark mark="fix" text={missing ?? page.keyError ?? ''} /></p>
    {/if}
  {/if}
  {#if page.cap}
    <b>Daily credit cap</b>
    <div class="keyrow">
      <input
        bind:value={capValue}
        type="number"
        min="1"
        step="1"
        inputmode="numeric"
        placeholder="No cap"
        aria-label="Daily credit cap"
        onkeydown={capKeydown}
      />
      <Button disabled={page.capBusy} onclick={saveCap}>{page.capBusy ? 'Saving…' : 'Save cap'}</Button>
    </div>
    <p class="why">
      The most ElevenLabs credits Mortiflix may spend in one day. Empty means no cap. Used today: {credits(
        page.cap.spent_today,
      )}{page.cap.daily_cap ? ` of ${credits(page.cap.daily_cap)}` : ''}.
    </p>
    {#if capMissing || page.capError}
      <p role="alert"><StatusMark mark="fix" text={capMissing ?? page.capError ?? ''} /></p>
    {/if}
  {/if}
</SettingsSection>

<style>
  .line,
  .keyrow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8) var(--s-16);
    min-width: 0;
  }
  .keyrow {
    gap: var(--s-8);
  }
  input {
    width: min(var(--field-w), 100%);
    height: var(--h);
    padding: 0 var(--s-16);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
  }
  input:focus-visible {
    outline: none;
    border-color: var(--link);
  }
  .need {
    max-width: 70ch;
  }
  .why {
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
