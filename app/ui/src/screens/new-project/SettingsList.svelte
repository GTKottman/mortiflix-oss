<!-- The five accordions, one per section of the schema. -->
<script lang="ts">
  import { useNewProject } from './context';
  import SettingsSection from './SettingsSection.svelte';

  const project = useNewProject();
  const { form } = project;
</script>

<!-- Frozen while the project is being created: a change then would be lost. -->
<div class="list" inert={project.busy} aria-busy={project.busy}>
  {#each form.schema?.sections ?? [] as section (section.id)}
    <SettingsSection {section} />
  {/each}
</div>

<style>
  .list {
    --wave-h: 6px;
    margin-top: var(--s-32);
    padding-top: var(--wave-h);
    background: var(--wave-line) repeat-x left top / 24px var(--wave-h);
  }
  .list[inert] {
    opacity: 0.7;
  }
</style>
