<!-- The Look brief (look.brief.get / look.brief.set): a style pack, or a font, colours, a vibe and a look, plus the
     owner's words. Saving changes what is made from now on; frames already made stay as they are. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import type { Caller } from '../../lib/stage-tools.svelte';
  import { useService } from '../../lib/stores/context';

  interface Props {
    /** Default: the service. */
    service?: Caller;
  }

  let { service }: Props = $props();

  interface LookBrief {
    pack?: string | null;
    font?: string;
    heading_font?: string;
    palette?: string[];
    vibe?: string;
    look?: string;
    words?: string;
  }
  interface Pack {
    id: string;
    name: string;
  }

  const fallback = useService();
  // svelte-ignore state_referenced_locally
  const client: Caller = service ?? fallback;
  const HEX = /^#[0-9a-f]{6}$/i;

  let loaded = $state(false);
  /** Why the stored brief could not be read. The form is not shown then: Save would overwrite the real brief. */
  let loadFailed = $state('');
  let packs = $state<Pack[]>([]);
  let fonts = $state<string[]>([]);
  let pack = $state('');
  let font = $state('');
  let heading = $state('');
  let colours = $state('');
  let vibe = $state('');
  let look = $state('');
  let words = $state('');
  let saving = $state(false);
  let said = $state('');
  let failed = $state('');

  // One swatch per colour: a colour typed twice is kept once (the swatches are keyed by colour).
  const palette = $derived(
    [
      ...new Set(
        colours
          .split(/[\s,]+/)
          .map((colour) => colour.trim())
          .filter((colour) => HEX.test(colour)),
      ),
    ].slice(0, 8),
  );

  onMount(() => void load());

  async function load() {
    loaded = false;
    loadFailed = '';
    const [brief, packList, fontList] = await Promise.all([
      // A failed read is not "no brief yet" (null): keep the reason apart.
      client.call<LookBrief | null>('look.brief.get').then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : 'unknown error' }),
      ),
      client.call<Pack[]>('look.packs').catch(() => []),
      client.call<string[]>('look.fonts').catch(() => []),
    ]);
    if ('error' in brief) {
      loadFailed = brief.error;
      loaded = true;
      return;
    }
    packs = packList;
    fonts = [...new Set(fontList)]; // keyed by name below: a repeated font must not throw each_key_duplicate
    const stored = brief.answer;
    pack = stored?.pack ?? '';
    font = stored?.font ?? '';
    heading = stored?.heading_font ?? '';
    colours = (stored?.palette ?? []).join(' ');
    vibe = stored?.vibe ?? '';
    look = stored?.look ?? '';
    words = stored?.words ?? '';
    loaded = true;
  }

  async function save() {
    if (loadFailed || saving) return;
    saving = true;
    failed = '';
    said = '';
    try {
      await client.call('look.brief.set', {
        pack: pack || null,
        font,
        heading_font: heading,
        palette,
        vibe,
        look,
        words,
      });
      said = 'Saved. What is made from now on uses it.';
    } catch (error) {
      failed = error instanceof Error ? error.message : 'unknown error';
    }
    saving = false;
  }
</script>

{#if !loaded}
  <LoadingState text="Loading the brief…" />
{:else if loadFailed}
  <ErrorState inline title="Couldn't read the brief" detail={loadFailed} onretry={() => void load()} />
{:else}
  <form
    class="brief"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <p class="muted">New frames and stills follow it. Frames already made stay as they are.</p>
    <label>
      <span>Style pack</span>
      <select bind:value={pack}>
        <option value="">None: use the fields below</option>
        {#each packs as entry (entry.id)}<option value={entry.id}>{entry.name}</option>{/each}
      </select>
    </label>
    <div class="pair">
      <label>
        <span>Font</span>
        <input type="text" list="look-fonts" bind:value={font} />
      </label>
      <label>
        <span>Heading font</span>
        <input type="text" list="look-fonts" bind:value={heading} />
      </label>
    </div>
    <datalist id="look-fonts">
      {#each fonts as name (name)}<option value={name}></option>{/each}
    </datalist>
    <label>
      <span>Colours (up to 8, like #1a1a2e #e94560)</span>
      <input type="text" bind:value={colours} />
    </label>
    {#if palette.length}
      <div class="swatches" aria-label="The colours">
        {#each palette as colour (colour)}<span class="swatch" style:background={colour} title={colour}
          ></span>{/each}
      </div>
    {/if}
    <div class="pair">
      <label>
        <span>Vibe</span>
        <input type="text" bind:value={vibe} />
      </label>
      <label>
        <span>Look</span>
        <input type="text" bind:value={look} />
      </label>
    </div>
    <label>
      <span>Your words</span>
      <textarea rows="3" bind:value={words}></textarea>
    </label>
    {#if failed}<p class="bad" role="alert">Not saved: {failed}</p>{/if}
    {#if said}<p class="good" role="status">{said}</p>{/if}
    <div class="row">
      <Button variant="primary" type="submit" disabled={saving}
        >{saving ? 'Saving…' : 'Save the brief'}</Button
      >
    </div>
  </form>
{/if}

<style>
  .brief {
    display: grid;
    gap: var(--s-12);
    max-width: var(--reading);
  }
  label {
    display: grid;
    gap: var(--s-4);
    color: var(--muted);
    font-size: var(--t13);
  }
  label span {
    white-space: nowrap;
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-12);
  }
  input,
  select,
  textarea {
    min-height: var(--h-sm);
    padding: var(--s-4) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink-2);
    color: var(--text);
    font-size: var(--t14);
  }
  textarea {
    resize: vertical;
  }
  .swatches {
    display: flex;
    gap: var(--s-4);
  }
  .swatch {
    width: var(--s-24);
    height: var(--s-24);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
  }
  .row {
    display: flex;
    gap: var(--s-12);
    align-items: center;
  }
  .row :global(button) {
    white-space: nowrap;
    flex-shrink: 0;
  }
  .muted {
    color: var(--muted);
  }
  .bad {
    color: var(--bad);
  }
  .good {
    color: var(--good);
  }
</style>
