<!-- Assets (owner, 2026-11-05: "There shouldn't be a lot of mystery in the application."): for the open project, every file
     it has made, what each AI call was sent and answered, and how far each New project setting reaches. Read-only. -->
<script lang="ts">
  import Accordion from '../../lib/components/Accordion.svelte';
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import Tabs, { tabId } from '../../lib/components/Tabs.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import { useProject, useService } from '../../lib/stores/context';
  import AssetViewer from './AssetViewer.svelte';
  import type { ProjectAssets, Viewed } from './types';

  type Tab = 'made' | 'sent' | 'carried';
  const TABS = [
    { id: 'made', label: 'Made' },
    { id: 'sent', label: 'Sent' },
    { id: 'carried', label: 'Carried forward' },
  ] as const;

  const client = useService();
  const project = useProject();

  let tab = $state<Tab>('made');
  let data = $state<ProjectAssets | null>(null);
  let problem = $state('');
  let viewed = $state<Viewed | null>(null);

  $effect(() => {
    const id = project.id;
    if (!id) return;
    let current = true;
    client.call<ProjectAssets>('project.files', { project: id }).then(
      (answer) => {
        if (current) data = answer;
      },
      (error: unknown) => {
        if (current) problem = error instanceof Error ? error.message : 'Could not list this project.';
      },
    );
    return () => {
      current = false;
    };
  });

  const size = (bytes: number): string =>
    bytes >= 1_048_576
      ? `${(bytes / 1_048_576).toFixed(1)} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${bytes} B`;
  const when = (iso: string): string =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const list = (items: string[]): string => items.join(', ');
</script>

<section class="screen">
  {#snippet back()}<a href={routeHref('/')}>‹ Projects</a> · {project.title}{/snippet}
  <ScreenHead
    kicker={back}
    title="Assets"
    help="Everything made for this project, what each AI call was sent, and how far your settings reach."
  />
  {#if !project.id}
    <EmptyState title="No project open" body="Open a project first, then its Assets are here.">
      {#snippet action()}<Button href={routeHref('/')}>Go to Projects</Button>{/snippet}
    </EmptyState>
  {:else if problem}
    <ErrorState title="Could not list this project" detail={problem} />
  {:else if !data}
    <LoadingState />
  {:else}
    <Tabs items={TABS} bind:value={tab} label="What to show" group="assets" onchange={() => (viewed = null)} />
    <div class="split" class:open={viewed} role="tabpanel" aria-labelledby={tabId('assets', tab)}>
      <div class="list">
        {#if tab === 'made'}
          {#if !data.groups.length}
            <EmptyState title="Nothing made yet" body="Files show up here as each stage makes them." />
          {/if}
          {#each data.groups as group (group.key)}
            <Accordion title={group.label} summary={`${group.files.length} files`}>
              <ul>
                {#each group.files as file (file.path)}
                  <li>
                    <button
                      type="button"
                      class:on={viewed?.path === file.path}
                      title={file.rel}
                      onclick={() => (viewed = { title: file.rel, path: file.path, kind: file.kind })}
                    >
                      <span class="name">{file.rel}</span>
                      <span class="side">{size(file.size)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </Accordion>
          {/each}
        {:else if tab === 'sent'}
          {#if !data.sent.length}
            <EmptyState
              title="No AI calls recorded yet"
              body="Recording started on 5 Nov 2026. Calls made before that were not kept."
            />
          {/if}
          <ul>
            {#each data.sent as call (call.file)}
              <li>
                <button
                  type="button"
                  class:on={viewed?.path === call.path}
                  onclick={() =>
                    (viewed = { title: `${call.stage} · ${when(call.at)}`, path: call.path, kind: 'text' })}
                >
                  <span class="name">{call.stage}{call.ok ? '' : ' · failed'}</span>
                  <span class="side">{call.model} · {when(call.at)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          {#if data.carried.idea}<p class="idea">{data.carried.idea}</p>{/if}
          {#if !data.carried.settings.length}
            <EmptyState title="No settings chosen" body="Everything was left for the studio to decide." />
          {/if}
          <ul class="settings">
            {#each data.carried.settings as setting (setting.id)}
              <li>
                <b>{setting.label}: <span>{setting.value}</span></b>
                <p>Reaches: {list(setting.reaches)}</p>
                {#if setting.misses.length}<p>Not read by: {list(setting.misses)}</p>{/if}
                {#if setting.stored_only}<p class="warn">Saved, but no step acts on it yet.</p>{/if}
              </li>
            {/each}
          </ul>
          <p class="left">{data.carried.left_to_studio} other settings left for the studio to decide.</p>
        {/if}
      </div>
      {#if viewed}<AssetViewer item={viewed} />{/if}
    </div>
  {/if}
</section>

<style>
  .screen {
    display: grid;
    gap: var(--s-24);
    min-width: 0;
  }
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-24);
    min-width: 0;
  }
  @media (min-width: 1200px) {
    .split.open {
      grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    }
    /* a file picked far down the list still shows beside it */
    .split.open > :global(.viewer) {
      position: sticky;
      top: var(--s-16);
      align-self: start;
    }
  }
  .list {
    display: grid;
    align-content: start;
    gap: var(--s-8);
    min-width: 0;
  }
  ul {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li button {
    display: flex;
    justify-content: space-between;
    gap: var(--s-16);
    width: 100%;
    min-height: 36px;
    align-items: center;
    padding: var(--s-4) var(--s-8);
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  li button:hover,
  li button.on {
    background: var(--ink-3);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .side {
    flex-shrink: 0;
    color: var(--muted);
    font-size: var(--t13);
    font-variant-numeric: tabular-nums;
  }
  .idea {
    max-width: var(--reading);
    margin: 0 0 var(--s-16);
    color: var(--text);
  }
  .settings {
    gap: var(--s-16);
  }
  .settings b {
    color: var(--text);
    font-weight: 500;
  }
  .settings b span {
    color: var(--muted);
    font-weight: 400;
  }
  .settings p,
  .left {
    margin: var(--s-4) 0 0;
    color: var(--muted);
    font-size: var(--t13);
  }
  .settings .warn {
    color: var(--text);
  }
  .left {
    margin-top: var(--s-16);
  }
</style>
