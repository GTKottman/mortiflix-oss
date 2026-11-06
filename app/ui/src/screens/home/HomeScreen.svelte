<!-- Home: find the video that needs you, see what is being made, open any project at its stage, start a new one.
     Groups by what you look for: Needs you, Making, Done and drafts. Problems show only in the Fix it strip. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import SearchField from '../../lib/components/SearchField.svelte';
  import { routeHref } from '../../lib/router.svelte';
  import { useApp } from '../../lib/stores/context';
  import type { StageId } from '../../lib/stages';
  import { provideHome } from './context';
  import { homeFixture } from './fixture';
  import { HomeProjects } from './home.svelte';
  import { neighbour } from './keys';
  import { projectParams } from './menu';
  import ProjectGroups from './ProjectGroups.svelte';
  import { countLine, matchesQuery, openScreenOf, splitGroups } from './projects';
  import { watchSetup } from './setup-watch.svelte';
  import type { HomeProject, ProjectChange } from './types';

  const { client, project: openProject, router, problems } = useApp();
  const fixture = import.meta.env.DEV && router.query.get('fixture') === 'home' ? homeFixture() : null;
  const caller = fixture ?? client;
  const home = new HomeProjects(caller);
  const setup = watchSetup(client, router, problems);

  let query = $state('');
  let opening = $state<string | null>(null);
  let failure = $state<{ id: string; message: string } | null>(null);
  let search = $state<ReturnType<typeof SearchField>>();
  let root = $state<HTMLElement>();

  const shown = $derived(home.list.filter((p) => matchesQuery(p, query)));
  const groups = $derived(splitGroups(shown));

  $effect(() => {
    const start = () => {
      void home.load();
      setup.load();
    };
    if (client.up || fixture) start();
    return client.on<{ up: boolean }>('bridge.state', (state) => state.up && start());
  });
  $effect(() => client.on<ProjectChange>('project.changed', (change) => void home.change(change)));

  // A refresh that failed after a good load keeps the old list: the Fix it strip says it may be out of date.
  const REFRESH_PROBLEM = 'home-refresh';
  $effect(() => {
    const why = home.refreshError;
    if (!why) {
      problems.clear(REFRESH_PROBLEM);
      return;
    }
    problems.raise({
      id: REFRESH_PROBLEM,
      kind: 'warn',
      text: `Couldn't refresh your projects: ${why}. The list may be out of date.`,
      fix: {
        label: 'Try again',
        run: async () => {
          await home.load();
          if (home.refreshError) throw new Error(home.refreshError);
          return 'Refreshed.';
        },
      },
    });
  });
  $effect(() => () => problems.clear(REFRESH_PROBLEM));

  async function open(project: HomeProject, stage?: StageId) {
    // One open at a time: a second one would race the first, and the last to answer would win the screen.
    if (opening) return;
    opening = project.id;
    failure = null;
    try {
      await openProject.load(project.id);
    } catch (error) {
      failure = { id: project.id, message: error instanceof Error ? error.message : 'unknown error' };
      opening = null;
      return;
    }
    opening = null;
    router.go(`/${stage ?? openScreenOf(project)}`);
  }

  /** The projects deleted this visit, newest last: Undo brings the newest back from the studio's trash, then the one
   * before it is offered, so a second delete never loses the first one's Undo. */
  let deletedList = $state<HomeProject[]>([]);
  const removed = $derived(deletedList.at(-1) ?? null);
  let undoing = $state(false);
  let undoFailed = $state('');

  async function undo() {
    const project = removed;
    if (!project) return;
    undoing = true;
    undoFailed = '';
    try {
      await caller.call('project.restore', projectParams(project));
      deletedList = deletedList.filter((p) => p.id !== project.id);
    } catch (error) {
      undoFailed = error instanceof Error ? error.message : 'unknown error';
    } finally {
      undoing = false;
      void home.load();
    }
  }

  provideHome({
    client: caller,
    open: (project, stage) => void open(project, stage),
    reload: () => void home.load(),
    deleted: (project) => {
      deletedList = [...deletedList.filter((p) => p.id !== project.id), project];
      undoFailed = '';
      void home.load();
    },
  });

  function arrows(event: KeyboardEvent) {
    const link =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-link]') : null;
    if (!link || event.defaultPrevented || !root) return;
    const links = [...root.querySelectorAll<HTMLElement>('[data-link]')].filter((l) => !l.closest('[inert]'));
    const next = neighbour(links, link, event.key);
    if (!next) return;
    event.preventDefault();
    next.focus();
  }
</script>

<div class="home" bind:this={root} role="presentation" onkeydown={arrows}>
  <ScreenHead title="What do you want to make?" />

  {#if home.list.length}
    <div class="tools">
      <div class="search">
        <!-- typing filters the list as you type; + starts a new project named with what is typed (owner 2026-11-03) -->
        <SearchField
          bind:this={search}
          bind:value={query}
          label="Search projects, or make a new one!"
          clearOnEscape
        >
          {#snippet end()}
            <a
              class="add"
              href={routeHref(query.trim() ? `/new?name=${encodeURIComponent(query.trim())}` : '/new')}
              aria-label={query.trim() ? `New project called "${query.trim()}"` : 'New project'}
              title={query.trim() ? `New project called "${query.trim()}"` : 'New project'}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </a>
          {/snippet}
        </SearchField>
      </div>
      <span class="count" aria-live="polite">{countLine(home.list.length, shown.length, query)}</span>
    </div>
  {/if}

  {#if removed}
    <p class="undo" role="status">
      <span class="gone"
        >{undoFailed
          ? `Could not bring back "${removed.title}": ${undoFailed}`
          : `Deleted "${removed.title}". It is in the studio's trash.`}</span
      >
      <Button size="sm" variant="text" disabled={undoing} onclick={() => void undo()}
        >{undoing ? 'Bringing it back…' : 'Undo'}</Button
      >
      <Button size="sm" variant="text" aria-label="Hide this message" onclick={() => (deletedList = [])}
        >✕</Button
      >
    </p>
  {/if}

  {#if home.phase === 'loading'}
    <LoadingState text="Loading your projects…" />
  {:else if home.phase === 'error'}
    <ErrorState title="Couldn't load your projects" detail={home.error} onretry={() => void home.load()} />
  {:else if !home.list.length}
    <div class="all-empty">
      <EmptyState
        title="No videos yet"
        body={`Write an idea and Mortiflix writes a brief, then the script. You OK each step: Script, Voice & music, Look, Stills, Motion, Sound, then it opens in ArtCraft.${setup.firstRun ? ' First, open Settings and check the connections.' : ''}`}
      >
        {#snippet action()}
          {#if setup.firstRun}
            <Button href={routeHref('/settings')}>Open Settings</Button>
          {:else}
            <Button variant="primary" href={routeHref('/new')}>New project</Button>
          {/if}
        {/snippet}
      </EmptyState>
    </div>
  {:else if !shown.length}
    <div class="all-empty">
      <EmptyState title={`No project called "${query.trim()}"`} body="Search looks at project names.">
        {#snippet action()}
          <Button
            size="sm"
            onclick={() => {
              query = '';
              search?.focus();
            }}>Clear search</Button
          >
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <ProjectGroups {groups} stills={home.stills} {opening} {failure} onopen={open} />
  {/if}
</div>

<style>
  .home {
    min-width: 0;
    padding-top: var(--s-16);
  }
  .search {
    --end-pad: var(--s-8);
    --search-align: center;
  }
  .add {
    display: grid;
    flex: none;
    place-items: center;
    width: calc(var(--h) - var(--s-16));
    height: calc(var(--h) - var(--s-16));
    border-radius: 50%;
    background: var(--grad);
    color: var(--on-grad);
  }
  .add:hover {
    filter: brightness(1.06);
  }
  .add:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  .add svg {
    width: var(--s-16);
    height: var(--s-16);
  }
  /* the search bar and the count under it, centered under the centered title (owner 2026-11-03) */
  .tools {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-32);
    margin-top: var(--s-32);
    padding-bottom: var(--s-16);
    background: var(--wave-line) repeat-x left bottom / 24px 6px;
  }
  .search {
    width: var(--field-w);
    max-width: 100%;
  }
  .count {
    flex-shrink: 0;
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
  .all-empty {
    padding: var(--s-48) 0;
  }
  .undo {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    margin-top: var(--s-16);
    color: var(--muted);
    font-size: var(--t14);
  }
  .gone {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-height: 800px) {
    .tools {
      margin-top: var(--s-16);
    }
  }
  @media (max-width: 1199px) {
    .tools {
      flex-wrap: wrap;
    }
  }
</style>
