<!-- "Change this sound", folded away: what it sounds like, when it starts and how long it is. Saving a made new sound
     remakes it later (credits), and says so before the owner presses Save. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import DoneNote from '../../lib/components/DoneNote.svelte';
  import { CREDITS_PER_SECOND, isNew } from './sound';
  import type { Cue, CueChange } from './types';

  interface Props {
    cue: Cue;
    open: boolean;
    /** Resolves true when the change was saved. */
    onsave: (change: CueChange) => Promise<boolean>;
  }

  let { cue, open = $bindable(), onsave }: Props = $props();

  // The parent keys this component by sound, so a different sound starts from its own saved values.
  let prompt = $state(untrack(() => cue.prompt));
  let length = $state(untrack(() => cue.dur_sec));
  let start = $state(untrack(() => cue.at_sec));
  let saved = $state(false);
  /** What is being saved: 'change' or 'new', or empty. */
  let saving = $state<'' | 'change' | 'new'>('');

  // An emptied number box binds as null: Save waits for real numbers instead of sending nothing.
  const valid = $derived(Number.isFinite(length) && length > 0 && Number.isFinite(start) && start >= 0);

  const remakes = $derived(
    isNew(cue) && Boolean(cue.file) && (prompt !== cue.prompt || length !== cue.dur_sec),
  );

  async function save(what: 'change' | 'new', change: CueChange) {
    saving = what;
    saved = await onsave(change);
    saving = '';
  }
</script>

<details bind:open>
  <summary>Change this sound</summary>
  <div class="fields">
    <label>
      What it sounds like
      <textarea rows="3" bind:value={prompt} oninput={() => (saved = false)}></textarea>
    </label>
    <div class="pair">
      <label>
        Starts at (s)
        <input type="number" min="0" step="0.1" bind:value={start} oninput={() => (saved = false)} />
      </label>
      <label>
        Length (s), same as the motion
        <input
          type="number"
          min="0.5"
          max="30"
          step="0.1"
          bind:value={length}
          oninput={() => (saved = false)}
        />
      </label>
    </div>
    {#if remakes}
      <p class="warn" role="status">
        Saving makes this sound again later (about {Math.max(1, Math.ceil(length * CREDITS_PER_SECOND))} credits).
      </p>
    {/if}
    <div class="row">
      <Button
        size="sm"
        disabled={Boolean(saving) || !valid}
        title={valid ? undefined : 'Fill in when it starts and how long it is'}
        onclick={() => save('change', { prompt, dur_sec: length, at_sec: start })}
        >{saving === 'change' ? 'Saving…' : 'Save changes'}</Button
      >
      {#if cue.source === 'library'}
        <Button
          size="sm"
          disabled={Boolean(saving) || !valid}
          onclick={() => save('new', { source: 'generate', prompt, dur_sec: length, at_sec: start })}
          >{saving === 'new' ? 'Saving…' : 'Make a new one instead'}</Button
        >
      {/if}
      {#if saved}<DoneNote text="Saved" ondone={() => (saved = false)} />{/if}
    </div>
  </div>
</details>

<style>
  summary {
    display: flex;
    align-items: center;
    min-height: var(--h-sm);
    color: var(--muted);
    font-size: var(--t14);
    white-space: nowrap;
    cursor: pointer;
  }
  details[open] summary {
    color: var(--text);
  }
  .fields {
    display: grid;
    gap: var(--s-12);
    padding-top: var(--s-8);
  }
  label {
    display: grid;
    gap: var(--s-4);
    color: var(--muted);
    font-size: var(--t13);
  }
  textarea,
  input {
    width: 100%;
    padding: var(--s-8) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    font-size: var(--t14);
    line-height: 1.4;
    resize: vertical;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-12);
  }
  .warn {
    color: var(--muted);
    font-size: var(--t13);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
  }
</style>
