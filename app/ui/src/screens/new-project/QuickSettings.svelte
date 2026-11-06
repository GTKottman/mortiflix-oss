<!-- The two choices above the accordions: where it will be seen, and how long. Auto length is the default. -->
<script lang="ts">
  import { useNewProject } from './context';
  import DestinationChoice from './DestinationChoice.svelte';
  import LengthChoice from './LengthChoice.svelte';

  const project = useNewProject();
</script>

<!-- Frozen while the project is being created: a change then would be lost. -->
<div class="quick" inert={project.busy} aria-busy={project.busy}>
  <DestinationChoice />
  <LengthChoice />
</div>

<style>
  .quick {
    --where-w: 575px;
    --length-w: 268px;
    --quick-gap: 165px;
    display: grid;
    grid-template-columns: minmax(0, var(--where-w)) minmax(0, var(--length-w));
    justify-content: center;
    gap: var(--s-24) var(--quick-gap);
  }
  .quick[inert] {
    opacity: 0.7;
  }
  @media (max-width: 1199px) {
    .quick {
      grid-template-columns: minmax(0, var(--where-w));
    }
  }
</style>
