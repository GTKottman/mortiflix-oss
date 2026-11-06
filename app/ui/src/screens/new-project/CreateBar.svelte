<!-- The row at the bottom: why Create script is not ready yet (or what happens next), Cancel (back to Projects, the
     draft stays), Save draft, Create script (Open project once it is made but did not open). -->
<script lang="ts">
  import Button from '../../lib/components/Button.svelte';
  import { useRouter } from '../../lib/stores/context';
  import { useNewProject } from './context';

  const project = useNewProject();
  const router = useRouter();
  const { draft } = project;
  const label = $derived(
    project.created
      ? project.busy
        ? 'Opening…'
        : 'Open project'
      : project.busy
        ? 'Creating…'
        : 'Create script',
  );
</script>

<div class="bar">
  <p class="why" aria-live="polite">{project.why}</p>
  <div class="buttons">
    <span class="saved">{draft.saved}</span>
    <Button disabled={project.busy} onclick={() => router.go('/')}>Cancel</Button>
    <Button disabled={project.busy || project.created} onclick={() => void draft.save(true)}
      >Save draft</Button
    >
    <Button
      variant="primary"
      size="lg"
      title="Ctrl+Enter"
      disabled={project.busy || !(project.valid || project.created)}
      onclick={() => void project.create()}>{label}</Button
    >
  </div>
</div>

<style>
  .bar {
    position: sticky;
    bottom: calc(-1 * var(--work-pad-y));
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-16);
    padding: var(--s-24) 0 var(--s-16);
    margin-bottom: calc(-1 * var(--work-pad-y));
    background: var(--ink);
  }
  .why {
    max-width: var(--reading);
    font-size: var(--t14);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--s-12);
    margin-left: auto;
  }
  .saved {
    color: var(--muted);
    font-size: var(--t13);
    white-space: nowrap;
  }
</style>
