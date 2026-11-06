<!-- The app window: top bar, Fix it strip (only when something is wrong), and the screen for the route. -->
<script lang="ts">
  import Button from './lib/components/Button.svelte';
  import EmptyState from './lib/components/EmptyState.svelte';
  import FixItStrip from './lib/components/FixItStrip.svelte';
  import TopBar from './lib/components/TopBar.svelte';
  import { routeHref } from './lib/router.svelte';
  import { useApp } from './lib/stores/context';
  import { watchPause } from './lib/stores/pause-watch.svelte';
  import { routeFor } from './routes/routes';
  import ScreenSlot from './routes/ScreenSlot.svelte';

  const { client, router, project, settings, usage, screenBar, problems } = useApp();
  const PROJECT_OPEN_PROBLEM = 'project-open';
  watchPause(client, router, problems, project);

  const route = $derived(routeFor(router.path));
  // The component kit is a dev page (sample numbers, fake states): loaded only on the Vite dev server, so it is not in
  // the production bundle's first load (Vite: import.meta.env.DEV is statically false in a build).
  const kit = import.meta.env.DEV ? import('./routes/Kit.svelte') : null;
  let usageOpen = $state(router.query.get('usage') === 'open');

  $effect(() =>
    client.on<{ up: boolean }>('bridge.state', (state) => {
      if (!state.up) return;
      void project.load().then(
        () => problems.clear(PROJECT_OPEN_PROBLEM),
        (error: unknown) => {
          console.error('project', error);
          problems.raise({
            id: PROJECT_OPEN_PROBLEM,
            kind: 'bad',
            text: `Could not open this tab's project: ${error instanceof Error ? error.message : 'unknown error'}`,
          });
        },
      );
      void settings.load();
      void usage.loadToday();
    }),
  );

  $effect.pre(() => {
    void route;
    screenBar.reset();
  });

  $effect(() => {
    document.title = `${route.title} · Mortiflix`;
  });
</script>

<div class="win">
  {#if route.kind === 'stage'}
    <TopBar
      stage={route.stage}
      count={screenBar.count}
      why={screenBar.why}
      ownPrimary={screenBar.ownPrimary}
      bind:usageOpen
    />
  {:else}
    <TopBar section={route.kind === 'section' ? route.section : 'projects'} bind:usageOpen />
  {/if}
  <FixItStrip />
  <main class="work">
    {#if route.kind === 'kit'}
      {#if kit}{#await kit then module}<module.default />{/await}{/if}
    {:else if route.kind === 'stage'}
      <!-- Keyed on the tab's project too: a stage screen's data and its OK buttons always belong to one project. -->
      {#key `${route.folder}|${project.id ?? ''}`}<ScreenSlot
          folder={route.folder}
          kicker="Stage"
          title={route.title}
        />{/key}
    {:else if route.kind === 'section'}
      {#key route.folder}<ScreenSlot folder={route.folder} kicker="Mortiflix" title={route.title} />{/key}
    {:else}
      <EmptyState title="No screen here" body="This address does not match a screen.">
        {#snippet action()}<Button href={routeHref('/')}>Go to Projects</Button>{/snippet}
      </EmptyState>
    {/if}
  </main>
</div>

<style>
  .win {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    /* one column exactly the window wide: a wide bar or screen scrolls inside itself, never widens the page */
    grid-template-columns: minmax(0, 1fr);
    width: 100vw;
    height: 100dvh;
    overflow: hidden;
    background: var(--ink);
  }
  .work {
    display: grid;
    align-content: start;
    gap: var(--s-24);
    min-height: 0;
    min-width: 0;
    padding: var(--work-pad-y) max(var(--work-pad-x), calc((100% - var(--page-max)) / 2));
    overflow: auto;
    overscroll-behavior: contain;
  }
</style>
