<!-- The open sound: play it, keep it (OK) or cut it; the details fold away under "Change this sound".
     `inline` = shown as a row under the sound in the list (narrow screens): title and buttons on one row, no facts. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { revealFile } from '../../lib/files';
  import { useService } from '../../lib/stores/context';
  import { cueStatus, sourceFact } from './sound';
  import ChangeSound from './ChangeSound.svelte';
  import MoreMenu, { type MenuAction } from '../../lib/components/MoreMenu.svelte';
  import type { Cue, CueChange } from './types';

  interface Props {
    cue: Cue;
    making: boolean;
    /** A change is being saved: the buttons wait. */
    busy: boolean;
    inline?: boolean;
    /** The "Change this sound" fold is open (kept while the owner moves between sounds). */
    changeOpen: boolean;
    onplay: () => void;
    onsignoff: () => void;
    oncut: () => void;
    onrestore: () => void;
    onchange: (change: CueChange) => Promise<boolean>;
  }

  let {
    cue,
    making,
    busy,
    inline = false,
    changeOpen = $bindable(),
    onplay,
    onsignoff,
    oncut,
    onrestore,
    onchange,
  }: Props = $props();

  const client = useService();
  const made = $derived(Boolean(cue.file));
  const status = $derived(cueStatus(cue, making));
  async function copyPath(): Promise<string> {
    const file = cue.file ?? '';
    try {
      await navigator.clipboard.writeText(file);
      return 'Path copied.';
    } catch {
      prompt('Copy this path:', file);
      return '';
    }
  }

  // Every action for this sound in one menu; the common ones also stay as buttons.
  const actions = $derived<MenuAction[]>(
    cue.status === 'cut'
      ? [{ label: 'Put it back', run: onrestore, why: busy ? 'Saving…' : undefined }]
      : [
          { label: 'Play', run: onplay, why: made ? undefined : 'Not made yet' },
          {
            label: 'OK this sound',
            run: onsignoff,
            why: !made ? 'Not made yet' : cue.status === 'ok' ? 'Already OK' : busy ? 'Saving…' : undefined,
          },
          { label: 'Change this sound', run: () => void (changeOpen = true) },
          { label: 'Copy path', run: copyPath, why: made ? undefined : 'Not made yet' },
          { label: 'Open folder', run: () => revealFile(client, cue.file ?? ''), why: made ? undefined : 'Not made yet' },
          { label: 'Cut', run: oncut, danger: true, why: busy ? 'Saving…' : undefined },
        ],
  );
</script>

{#snippet buttons()}
  <div class="buttons">
    {#if cue.status === 'cut'}
      <Button size="sm" disabled={busy} onclick={onrestore}>Put it back</Button>
    {:else}
      <Button size="sm" disabled={!made} title={made ? undefined : 'Not made yet'} onclick={onplay}
        >▶ Play</Button
      >
      <Button size="sm" variant="good" disabled={busy || !made || cue.status === 'ok'} onclick={onsignoff}>
        {cue.status === 'ok' ? '✓ OK' : 'OK this sound'}
      </Button>
      <Button size="sm" variant="danger" disabled={busy} onclick={oncut}>Cut</Button>
    {/if}
    <MoreMenu label={`More for ${cue.what}`} {actions} />
  </div>
{/snippet}

<div class="sound" class:inline>
  {#if inline}
    <div class="inline-row">
      <h3>{cue.what}</h3>
      {@render buttons()}
    </div>
  {:else}
    <h3>{cue.what}</h3>
    <dl>
      <div>
        <dt>Source</dt>
        <dd>{sourceFact(cue)}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd><StatusMark plain mark={status.mark} text={status.text} /></dd>
      </div>
    </dl>
    {@render buttons()}
  {/if}
  {#key cue.id}<ChangeSound {cue} bind:open={changeOpen} onsave={onchange} />{/key}
</div>

<style>
  .sound {
    display: grid;
    gap: var(--s-16);
    align-content: start;
    padding-top: var(--s-16);
    border-top: 1px solid var(--line);
  }
  .inline {
    gap: var(--s-8);
    padding-top: 0;
    border-top: 0;
  }
  .inline-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-16);
  }
  h3 {
    font: 600 var(--t16) / 1.3 var(--body);
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: var(--s-12);
    padding: var(--s-8) 0;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--t13);
  }
  dd {
    color: var(--text);
    text-align: right;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
</style>
