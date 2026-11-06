<!-- New project, laid out from the owner's drawing (Mortiflix Create a Video - original.svg, 2026-11-05): one sentence
     is enough to start; everything below it is optional. The name, the idea, the source tray, two quick choices and
     five accordions in one centred column. Create script starts the script. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import SourceTray from '../../lib/components/SourceTray.svelte';
  import { pageParam } from '../../lib/page';
  import { useProblems, useProject, useRouter, useService } from '../../lib/stores/context';
  import ConflictNote from './ConflictNote.svelte';
  import ContinueDrafts from './ContinueDrafts.svelte';
  import BriefSuggestions from './BriefSuggestions.svelte';
  import { provideNewProject } from './context';
  import CreateBar from './CreateBar.svelte';
  import { applyDemo, demoSuggestions, isDemoName } from './demo';
  import IdeaField from './IdeaField.svelte';
  import { conflictsAt } from './brief';
  import { NewProject } from './newProject.svelte';
  import QuickSettings from './QuickSettings.svelte';
  import SettingsList from './SettingsList.svelte';

  const client = useService();
  const problems = useProblems();
  const router = useRouter();
  const openProject = useProject();

  const asked = import.meta.env.DEV ? pageParam('demo') : null; // screenshot states: dev builds only
  const demo = isDemoName(asked) ? asked : null;

  /** The new project opens at Script: the brief being written, then waiting for your OK. */
  async function openScript(id: string) {
    await openProject.load(id);
    router.go('/script');
  }

  const project = new NewProject(client, problems, {
    onCreated: openScript,
    demo: demoSuggestions(demo),
  });
  provideNewProject(project);

  let main = $state<HTMLElement>();

  onMount(() => {
    // "Add to the source tray" (ReferencesRow) asks for 'link': the tray's own link box (AddSource, aria-label below).
    const stopFocus = project.registerFocus('link', () =>
      main?.querySelector<HTMLInputElement>('input[aria-label="Add a link"]')?.focus(),
    );
    const stopListening = project.sources.listen();
    void project.start().then(() => {
      if (demo) applyDemo(project, demo, problems);
      // Home's + with words typed in the search: they are the new project's name
      const name = router.query.get('name')?.trim();
      if (name) project.form.setTitle(name);
      if (!document.activeElement || document.activeElement === document.body) project.focus('idea');
    });
    return () => {
      stopFocus();
      stopListening();
    };
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void project.create();
  }}
/>

<section class="screen" class:busy={project.busy}>
  <ScreenHead kicker="New project" title="Create a video" />
  <div class="main" bind:this={main}>
    <ContinueDrafts />
    <IdeaField />
    <BriefSuggestions />
    <div class="source">
      <SourceTray
        sources={project.sources.items}
        onadd={(source) => project.sources.add(source)}
        onremove={(id) => project.sources.remove(id)}
      >
        {#each conflictsAt(project.live.conflicts, 'sources') as conflict (conflict.id)}<ConflictNote
            {conflict}
          />{/each}
      </SourceTray>
    </div>
    <QuickSettings />
    <SettingsList />
  </div>
  <CreateBar />
</section>

<style>
  .screen {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto 1fr auto;
    gap: var(--s-24);
    /* the buttons sit on the bottom edge of the window, however short the page is */
    min-height: calc(100dvh - var(--bar-h) - 2 * var(--work-pad-y));
  }
  .screen :global(h1) {
    margin-top: var(--s-16);
  }
  .main {
    display: grid;
    align-content: start;
    gap: var(--s-24);
    min-width: 0;
  }
  .source {
    --source-w: 1174px;
    justify-self: center;
    width: min(100%, var(--source-w));
    margin-top: var(--s-16);
  }
  .busy .main {
    opacity: 0.65;
    pointer-events: none;
  }
  @media (max-height: 800px) {
    .screen,
    .main {
      gap: var(--s-16);
    }
  }
</style>
