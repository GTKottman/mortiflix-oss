<!-- The safe zone of the main shape, drawn: keep titles inside the dashed line. -->
<script lang="ts">
  import Note from './Note.svelte';
  import { safeZoneNote, safeZoneShape } from './safeZone';

  interface Props {
    aspect: string;
  }

  let { aspect }: Props = $props();
  const shape = $derived(safeZoneShape(aspect));
</script>

<div class="safe">
  <svg
    viewBox="0 0 {shape.width} {shape.height}"
    width={shape.width}
    height={shape.height}
    role="img"
    aria-label="Safe zone for {aspect}"
  >
    <rect width={shape.width} height={shape.height} class="ground" />
    {#each shape.covered as area (area.y)}
      <rect x={area.x} y={area.y} width={area.width} height={area.height} class="covered" />
    {/each}
    <rect
      x={shape.margin}
      y={shape.margin}
      width={shape.width - 2 * shape.margin}
      height={shape.height - 2 * shape.margin}
      class="limit"
    />
  </svg>
  <Note as="span">{safeZoneNote(aspect)}</Note>
</div>

<style>
  .safe {
    display: flex;
    align-items: center;
    gap: var(--s-16);
  }
  svg {
    --picture-h: 90px;
    flex: none;
    height: var(--picture-h);
    border-radius: var(--r-sm);
  }
  .ground {
    fill: var(--ink-3);
  }
  .covered {
    fill: var(--bad);
    opacity: 0.35;
  }
  .limit {
    fill: none;
    stroke: var(--link);
    stroke-dasharray: 3 3;
  }
</style>
