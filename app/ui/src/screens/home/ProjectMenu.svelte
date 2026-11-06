<!-- A project's ⋯ menu: open it (here, in a new tab, or at any stage it reached), rename, duplicate, open its
     folder, copy its name or link, pause, resume or stop it, delete it. Stop and Delete ask first with Keep focused;
     a delete goes to the studio's trash and Home offers Undo. -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import MoreMenu from '../../lib/components/MoreMenu.svelte';
  import { tick } from 'svelte';
  import { stageById, type StageId } from '../../lib/stages';
  import { useProblems } from '../../lib/stores/context';
  import { useHome } from './context';
  import { revealFile } from '../../lib/files';
  import {
    ACTION_WORDS,
    cleanTitle,
    duplicateChoices,
    projectFolder,
    projectLink,
    projectParams,
    reachedStages,
    runActions,
    SERVICE_CALL,
    TITLE_MAX,
    type DuplicateChoice,
    type RunAction,
  } from './menu';
  import { openHref, openNameOf, screenOf, stageNameOf } from './projects';
  import type { HomeProject } from './types';

  interface Props {
    project: HomeProject;
  }

  let { project }: Props = $props();

  const home = useHome();
  const client = home.client;
  const problems = useProblems();

  /** The menu's question in place of its items: stop or delete (asks first), or the new name. */
  type Asking = 'stop' | 'delete' | 'rename' | null;

  let open = $state(false);
  let asking = $state<Asking>(null);
  let name = $state('');
  let nameField = $state<HTMLInputElement>();
  let busy = $state(false);
  let said = $state('');
  let menu = $state<ReturnType<typeof MoreMenu>>();

  const here = $derived(screenOf(project));
  const others = $derived(reachedStages(project).filter((stage) => stage !== here));
  const runs = $derived(runActions(project));
  const copies = $derived(duplicateChoices(project));
  const href = $derived(openHref(project));
  const problemId = $derived(`home-run-${project.id}`);

  $effect(() => {
    if (open) return;
    asking = null;
    said = '';
  });

  function go(close: (refocus: boolean) => void, stage?: StageId) {
    close(false);
    home.open(project, stage);
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      said = `${what} copied.`;
    } catch {
      said = `Could not copy the ${what.toLowerCase()}: the browser did not allow it.`;
    }
  }

  function ask(what: Exclude<Asking, null>) {
    asking = what;
    if (what === 'rename') {
      name = project.title;
      void tick().then(() => nameField?.select());
    } else void menu?.focusFirst();
  }

  /** Calls the service; a failure goes to the Fix it strip in words. True when it worked. */
  async function call(type: string, params: Record<string, unknown>, verb: string): Promise<boolean> {
    busy = true;
    try {
      await client.call(type, params);
      problems.clear(problemId);
      return true;
    } catch (error) {
      problems.raise({
        id: problemId,
        kind: 'bad',
        text: `Could not ${verb} "${project.title}": ${error instanceof Error ? error.message : 'unknown error'}.`,
      });
      return false;
    } finally {
      busy = false;
    }
  }

  async function run(action: RunAction, close: (refocus: boolean) => void) {
    if (action === 'stop' && asking !== 'stop') return ask('stop');
    if (await call(SERVICE_CALL[action], projectParams(project), ACTION_WORDS[action].verb)) home.reload();
    close(true);
  }

  async function rename(event: SubmitEvent, close: (refocus: boolean) => void) {
    event.preventDefault();
    const title = cleanTitle(name);
    if (!title || title === project.title) return close(true);
    if (await call('project.rename', { ...projectParams(project), title }, 'rename')) home.reload();
    close(true);
  }

  async function duplicate(choice: DuplicateChoice) {
    const params = choice.upto ? { ...projectParams(project), upto: choice.upto } : projectParams(project);
    if (!(await call('project.duplicate', params, 'duplicate'))) return;
    said = `Copy made: "${project.title} (copy)". It waits paused until you resume it.`;
    home.reload();
  }

  async function remove(close: (refocus: boolean) => void) {
    if (asking !== 'delete') return ask('delete');
    const done = await call('project.delete', projectParams(project), 'delete');
    close(!done);
    if (done) home.deleted(project);
  }

  /** Arrow keys, Home and End move the text cursor here, and Tab moves between the field and its buttons. */
  function keepKeys(event: KeyboardEvent) {
    if (event.key !== 'Escape') event.stopPropagation();
  }
</script>

<MoreMenu bind:this={menu} bind:open label={`More for ${project.title}`}>
  {#snippet children(close)}
    {#if asking === 'stop'}
      <p class="words">Stop "{project.title}" at {stageNameOf(project)}? Mortiflix stops working on it.</p>
      <Button item role="menuitem" onclick={() => close(true)}>Keep it going</Button>
      <Button item variant="danger" role="menuitem" disabled={busy} onclick={() => void run('stop', close)}
        >{busy ? 'Stopping…' : 'Stop it'}</Button
      >
    {:else if asking === 'delete'}
      <p class="words">Delete "{project.title}"? It goes to the studio's trash; Undo brings it back.</p>
      <Button item role="menuitem" onclick={() => close(true)}>Keep it</Button>
      <Button item variant="danger" role="menuitem" disabled={busy} onclick={() => void remove(close)}
        >{busy ? 'Deleting…' : 'Delete it'}</Button
      >
    {:else if asking === 'rename'}
      <form
        class="rename"
        role="presentation"
        onkeydown={keepKeys}
        onsubmit={(event) => void rename(event, close)}
      >
        <label class="label" for="rename-{project.id}">New name</label>
        <input
          bind:this={nameField}
          bind:value={name}
          id="rename-{project.id}"
          class="field"
          maxlength={TITLE_MAX}
          autocomplete="off"
        />
        <span class="buttons">
          <Button size="sm" type="button" onclick={() => close(true)}>Cancel</Button>
          <Button size="sm" variant="primary" type="submit" disabled={busy || !cleanTitle(name)}
            >{busy ? 'Saving…' : 'Save'}</Button
          >
        </span>
      </form>
    {:else}
      <Button item role="menuitem" onclick={() => go(close)}>Open {openNameOf(project)}</Button>
      <Button item role="menuitem" {href} target="_blank" onclick={() => close(false)}
        >Open in a new tab</Button
      >
      {#if others.length}
        <span class="label">Open at</span>
        {#each others as stage (stage)}
          <Button item role="menuitem" onclick={() => go(close, stage)}>{stageById(stage).label}</Button>
        {/each}
      {/if}
      <hr />
      <Button item role="menuitem" onclick={() => ask('rename')}>Rename…</Button>
      {#each copies as choice (choice.label)}
        <Button item role="menuitem" disabled={busy} onclick={() => void duplicate(choice)}
          >{choice.label}</Button
        >
      {/each}
      <Button
        item
        role="menuitem"
        onclick={() => void revealFile(client, projectFolder(project)).then((answer) => (said = answer))}
        >Open folder</Button
      >
      <Button item role="menuitem" onclick={() => void copy(project.title, 'Name')}>Copy name</Button>
      <Button item role="menuitem" onclick={() => void copy(projectLink(location.href, href), 'Link')}
        >Copy link</Button
      >
      {#if runs.length}
        <hr />
        {#each runs as action (action)}
          <Button
            item
            role="menuitem"
            variant={action === 'stop' ? 'danger' : 'secondary'}
            disabled={busy}
            onclick={() => void run(action, close)}>{ACTION_WORDS[action].label}</Button
          >
        {/each}
      {/if}
      <hr />
      <Button item variant="danger" role="menuitem" onclick={() => void remove(close)}>Delete…</Button>
      {#if said}<p class="words" role="status">{said}</p>{/if}
    {/if}
  {/snippet}
</MoreMenu>

<style>
  .label {
    padding: var(--s-8) var(--s-12) var(--s-4);
    color: var(--faint);
    font: 600 var(--t11) / 1 var(--body);
    letter-spacing: var(--track-kicker);
    text-transform: uppercase;
  }
  .words {
    padding: var(--s-8) var(--s-12);
    color: var(--muted);
    font-size: var(--t13);
  }
  .rename {
    display: grid;
    gap: var(--s-8);
    padding: var(--s-4) var(--s-12) var(--s-12);
  }
  .rename .label {
    padding: var(--s-4) 0 0;
  }
  .field {
    width: 100%;
    min-width: 0;
    padding: var(--s-8) var(--s-12);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    background: var(--ink);
    color: var(--text);
    font: inherit;
    font-size: var(--t14);
  }
  .field:focus-visible {
    outline: none;
    border-color: var(--link);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-8);
  }
</style>
