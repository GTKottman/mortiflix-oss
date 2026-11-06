<!-- One icon from the Video Notes app, in the text colour around it. -->
<script lang="ts">
  import { MARK_ICONS, type MarkIconName, type MarkIconShape } from './mark-icons';

  interface Props {
    name: MarkIconName;
    size?: number;
  }

  let { name, size = 20 }: Props = $props();

  const shape = $derived<MarkIconShape>(MARK_ICONS[name]);
</script>

<svg
  width={size}
  height={size}
  viewBox={`0 0 ${shape.size} ${shape.size}`}
  fill={shape.line ? 'none' : 'currentColor'}
  stroke={shape.line ? 'currentColor' : 'none'}
  stroke-width={shape.line ? 2 : 0}
  aria-hidden="true"><path d={shape.path} /></svg
>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
