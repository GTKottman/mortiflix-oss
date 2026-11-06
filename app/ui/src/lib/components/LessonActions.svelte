<!-- Decide the lesson a note proposed: use in every project, only in this one, or not a lesson. After Use, it can be
     switched off (the service has no un-approve: it stays approved, Off). Focus stays in the group as its buttons
     change (Not a lesson puts it on Keep), so a keyboard user is never dropped to the page. -->
<script lang="ts">
  import { tick } from 'svelte';
  import type { ReviewService } from '../review/types';
  import Button from './Button.svelte';
  import ErrorState from './ErrorState.svelte';

  interface Props {
    service: ReviewService;
    lessonId: string;
    /** The open project's title, for "Only in …". */
    projectTitle?: string;
    onchange: () => void;
    onedit: () => void;
    /** The Edit button's words; say where it goes when it leaves the screen ("Edit in Lessons ›"). */
    editLabel?: string;
  }

  let { service, lessonId, projectTitle = '', onchange, onedit, editLabel = 'Edit' }: Props = $props();

  let group = $state<HTMLElement>();

  /** After the buttons change: focus `pick` (or the first button), or the group itself when none is left. */
  async function keepFocus(pick?: (buttons: HTMLButtonElement[]) => HTMLButtonElement | undefined) {
    if (!group?.contains(document.activeElement) && document.activeElement !== document.body) return;
    await tick();
    const buttons = [...(group?.querySelectorAll('button') ?? [])];
    (pick?.(buttons) ?? buttons[0] ?? group)?.focus();
  }

  /** What the last decision did; null = not decided yet. Switch off only after Use (a deleted lesson is gone). */
  let saved = $state<'used' | 'deleted' | null>(null);
  let failure = $state<{ title: string; detail: string; retry?: () => void } | null>(null);
  let confirming = $state(false);

  async function run(work: () => Promise<unknown>, again: () => void, title: string, done: typeof saved) {
    failure = null;
    const had = Boolean(group?.contains(document.activeElement));
    try {
      await work();
    } catch (error) {
      failure = { title, detail: error instanceof Error ? error.message : 'unknown error', retry: again };
      return;
    }
    saved = done;
    if (had) void keepFocus();
    onchange();
  }

  const approve = (scope: 'all' | 'project') =>
    run(
      () => service.call('lessons.approve', { id: lessonId, scope }),
      () => void approve(scope),
      'Could not save that',
      'used',
    );
  const switchOff = () =>
    run(
      () => service.call('lessons.toggle', { id: lessonId, on: false }),
      () => void switchOff(),
      'Could not switch it off',
      null,
    );
  const remove = async () => {
    confirming = false;
    await run(
      () => service.call('lessons.delete', { id: lessonId }),
      () => void remove(),
      'Could not delete it',
      'deleted',
    );
  };
</script>

<div class="actions" role="group" aria-label="Decide this lesson" tabindex="-1" bind:this={group}>
  {#if failure}
    <ErrorState inline title={failure.title} detail={failure.detail} onretry={failure.retry} />
  {:else if saved === 'deleted'}
    <span class="why">Deleted. It is not a lesson.</span>
  {:else if saved === 'used'}
    <span class="why">Saved.</span>
    <Button size="sm" variant="text" onclick={switchOff}>Switch it off</Button>
  {:else if confirming}
    <span class="ask" role="group" aria-label="Delete this note's lesson?">
      Delete this note's lesson?
      <Button size="sm" variant="danger" onclick={remove}>Delete</Button>
      <Button
        size="sm"
        onclick={() => {
          confirming = false;
          void keepFocus((buttons) => buttons.find((button) => button.textContent?.trim() === 'Not a lesson'));
        }}>Keep</Button
      >
    </span>
  {:else}
    <Button size="sm" onclick={() => approve('all')}>Use in every project</Button>
    <Button size="sm" onclick={() => approve('project')}
      >{projectTitle ? `Only in ${projectTitle}` : 'Only in this project'}</Button
    >
    <Button
      size="sm"
      variant="text"
      onclick={() => {
        confirming = true;
        void keepFocus((buttons) => buttons.find((button) => button.textContent?.trim() === 'Keep'));
      }}>Not a lesson</Button
    >
    <Button size="sm" variant="text" onclick={onedit}>{editLabel}</Button>
  {/if}
</div>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    margin-top: var(--s-4);
  }
  .actions:focus {
    outline: none;
  }
  .why {
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--t13);
  }
  .ask {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-8);
    font-size: var(--t13);
  }
</style>
