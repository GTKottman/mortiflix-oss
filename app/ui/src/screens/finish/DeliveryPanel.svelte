<!-- The delivery panel: the video's state, its specs, and the one main action for that state.
     Ready: Download (the screen's one gradient button). Out of date: Update. Making: progress and Cancel.
     Not made: Make the video (free, on this computer). -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import LinkButton from '../../lib/components/LinkButton.svelte';
  import StatusMark from '../../lib/components/StatusMark.svelte';
  import { revealFile } from '../../lib/files';
  import { useService } from '../../lib/stores/context';
  import { ARTCRAFT_REBUILDS, madeWhen, queueWords } from './finish';
  import MoreMenu, { type MenuAction } from '../../lib/components/MoreMenu.svelte';
  import type { FinalStatus } from './types';

  interface Props {
    status: FinalStatus;
    /** The file was made but has gone missing. */
    lost: boolean;
    /** Make was pressed and the service has not answered. */
    starting: boolean;
    /** Cancel was pressed and the service has not answered. */
    stopping: boolean;
    /** Something stops the video being made (shown in the Fix it strip). */
    blocked: boolean;
    /** "1:00 · 1920×1080 · 30 fps · MP4 · 84 MB" */
    specs: string;
    /** Where the video file can be fetched, and the name to save it under. */
    href?: string;
    saveAs: string;
    /** The video file on this computer, for Copy path. */
    path: string;
    onmake: () => void;
    oncancel: () => void;
    onartcraft: () => Promise<void>;
  }

  let {
    status,
    lost,
    starting,
    stopping,
    blocked,
    specs,
    href,
    saveAs,
    path,
    onmake,
    oncancel,
    onartcraft,
  }: Props = $props();

  const client = useService();
  let message = $state('');
  /** Open in ArtCraft was picked: it asks first (it rebuilds the ArtCraft project). */
  let askArtcraft = $state(false);
  const made = $derived(madeWhen(status.made_at));

  // A note about the last download belongs to that file: it goes when the video's state changes.
  $effect(() => {
    void status.state;
    message = '';
  });

  const ready = $derived((status.state === 'done' || status.state === 'stale') && !lost);
  const stale = $derived(status.state === 'stale');
  const percent = $derived(
    status.progress && status.progress.total
      ? Math.round((status.progress.done / status.progress.total) * 100)
      : null,
  );

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      message = done;
    } catch {
      message = `Copy this by hand: ${text}`;
    }
  }

  async function artcraft() {
    askArtcraft = false;
    message = 'Writing the ArtCraft file…';
    try {
      await onartcraft();
      message = 'Opened in ArtCraft.';
    } catch (error) {
      message = error instanceof Error ? error.message : 'Could not open ArtCraft.';
    }
  }

  // Every action for the finished file; Download stays the one big button.
  const actions = $derived<MenuAction[]>([
    { label: 'Download video', run: () => download() },
    { label: 'Open in a new tab', run: () => void window.open(href, '_blank', 'noopener') },
    {
      label: 'Copy path',
      run: () => copy(path, 'Path copied.'),
      why: path ? undefined : 'The file has no path yet',
    },
    {
      label: 'Open folder',
      run: async () => void (message = await revealFile(client, path)),
      why: path ? undefined : 'The file has no path yet',
    },
    {
      label: 'Copy link',
      run: () => copy(new URL(href ?? '', location.href).href, 'Link copied.'),
    },
    {
      label: 'Open in ArtCraft',
      run: () => {
        message = '';
        askArtcraft = true;
      },
    },
    {
      label: stale ? 'Update the video' : 'Make the video again',
      run: onmake,
      why: starting ? 'Starting…' : blocked ? 'Fix the problem above first' : undefined,
    },
  ]);

  // The file is checked before it is handed over, so a failed download is said out loud instead of silently nothing.
  async function download(event?: MouseEvent) {
    event?.preventDefault();
    if (!href) return;
    message = '';
    try {
      const reply = await fetch(href, { method: 'HEAD' });
      if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
    } catch {
      message = 'fail';
      return;
    }
    const handOver = document.createElement('a');
    handOver.href = href;
    handOver.download = saveAs;
    document.body.append(handOver);
    handOver.click();
    handOver.remove();
    message = 'The download was handed to your browser. Check its downloads for the file.';
  }
</script>

<section aria-labelledby="delivery-h">
  <h2 id="delivery-h">Delivery</h2>
  {#if status.state === 'rendering'}
    <p class="state">
      <StatusMark mark="busy" size="lg" text={status.queued ? 'Waiting in the queue' : 'Making the video'} />
      {#if percent !== null}<span class="specs">{percent}%</span>{/if}
    </p>
    <p class="specs">
      {status.queued
        ? queueWords(status.renders_ahead)
        : status.progress?.phase || 'Putting everything together.'}
    </p>
    <div class="buttons">
      <Button size="lg" wide disabled>Download video</Button>
      <div class="sub">
        <Button grow disabled={stopping} onclick={oncancel}>{stopping ? 'Stopping…' : 'Cancel'}</Button>
      </div>
    </div>
  {:else if ready}
    <p class="state">
      {#if stale}<StatusMark mark="fix" size="lg" text="Out of date" />
      {:else}<StatusMark mark="ok" size="lg" text="Render complete" />{/if}
    </p>
    <p class="specs">{specs}{made ? ` · made ${made}` : ''}</p>
    {#if stale}<p class="why">
        {status.stale_why || 'A shot or sound changed after this video was made.'}
      </p>{/if}
    <div class="buttons">
      {#if stale}
        <div class="sub">
          <Button variant="primary" size="lg" grow disabled={starting || blocked} onclick={onmake}>
            {starting ? 'Starting…' : 'Update the video'}
          </Button>
          <MoreMenu label="More for the video" {actions} />
        </div>
        <div class="sub">
          <Button grow {href} download={saveAs} onclick={download}>Download the earlier one</Button>
          <Button grow {href} target="_blank">Open in a new tab</Button>
        </div>
      {:else}
        <Button variant="primary" size="lg" wide {href} download={saveAs} onclick={download}
          >Download video</Button
        >
        <div class="sub">
          <Button grow {href} target="_blank">Open in a new tab</Button>
          <MoreMenu label="More for the video" {actions} />
        </div>
      {/if}
    </div>
    <p class="note" role="status">
      {#if askArtcraft}{ARTCRAFT_REBUILDS}
        <LinkButton onclick={() => void artcraft()}>Open in ArtCraft</LinkButton>
        <LinkButton onclick={() => (askArtcraft = false)}>Keep the last one</LinkButton>
      {:else if message === 'fail'}The download couldn't start.
        <LinkButton onclick={() => void download()}>Try again</LinkButton>
      {:else}{message}{/if}
    </p>
  {:else}
    <p class="state"><span class="specs">{lost ? 'File missing' : 'Not made yet'}</span></p>
    <p class="specs">Making it is free and happens on this computer.</p>
    <div class="buttons">
      <Button
        variant={blocked ? 'secondary' : 'primary'}
        size="lg"
        wide
        disabled={starting || blocked}
        onclick={onmake}
      >
        {starting ? 'Starting…' : lost ? 'Make it again' : 'Make the video'}
      </Button>
    </div>
    {#if blocked}<p class="why">It can be made once the problem above is fixed.</p>{/if}
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: var(--s-12);
    min-width: 0;
  }
  h2 {
    color: var(--faint);
    font: 600 var(--t12) / 1.2 var(--body);
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .state {
    display: flex;
    align-items: center;
    gap: var(--s-8);
  }
  .state .specs {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .specs {
    color: var(--muted);
    font-size: var(--t14);
    line-height: 1.5;
  }
  .why {
    color: var(--muted);
    font-size: var(--t13);
  }
  .buttons {
    display: grid;
    gap: var(--s-12);
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-12);
  }
  .note {
    color: var(--muted);
    font-size: var(--t13);
    overflow-wrap: anywhere;
  }
  .note:empty {
    display: none;
  }
</style>
