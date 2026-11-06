<!-- A screen that has not moved to Svelte yet: its head and a link to today's page. -->
<script lang="ts">
  import Button from '../lib/components/Button.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import ScreenHead from '../lib/components/ScreenHead.svelte';
  import { useProject } from '../lib/stores/context';

  interface Props {
    kicker: string;
    title: string;
    oldPage: string;
  }

  let { kicker, title, oldPage }: Props = $props();
  const project = useProject();
  const oldHref = $derived(
    `/screens/${oldPage}.html${project.id ? `?project=${encodeURIComponent(project.id)}` : ''}`,
  );
</script>

<ScreenHead {kicker} {title} />
<EmptyState title="This screen moves here next" body="Until then, today's screen does the work.">
  {#snippet action()}<Button href={oldHref}>Open today's {title} screen</Button>{/snippet}
</EmptyState>
