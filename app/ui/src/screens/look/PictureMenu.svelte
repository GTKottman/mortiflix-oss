<!-- The ⋯ menu for the frame or still on view: open the picture full size, copy its path, open its folder, and Fix / OK (the same as
     the big buttons). Sits at the end of the Fix / OK row; Look and Stills share it. -->
<script lang="ts">
  import { fileUrl, revealFile } from '../../lib/files';
  import { useService } from '../../lib/stores/context';
  import type { ReviewItem } from '../../lib/review/types';
  import MoreMenu, { type MenuAction } from '../../lib/components/MoreMenu.svelte';

  interface Props {
    item: ReviewItem;
    /** The version on view; null = the newest. */
    version: number | null;
    /** Notes waiting for Fix. */
    waiting: number;
    /** What the screen is doing now ("Saving…"); empty when idle. */
    busy: string;
    onok: () => void;
    onfix: () => void;
    /** The screen's own items, after the picture's (Look: "Use this look"). */
    extra?: readonly MenuAction[];
  }

  let { item, version, waiting, busy, onok, onfix, extra = [] }: Props = $props();

  const client = useService();

  const path = $derived(item.versions.find((entry) => entry.v === version)?.path || item.path);
  const notReady = $derived(
    busy ||
      (item.state === 'review' ? '' : item.state === 'ok' ? `This ${item.noun} is OK` : 'Not ready yet'),
  );

  async function copy(): Promise<string> {
    try {
      await navigator.clipboard.writeText(path);
      return 'Path copied.';
    } catch {
      prompt('Copy this path:', path);
      return '';
    }
  }

  const actions = $derived<MenuAction[]>([
    {
      label: 'Open full size in a new tab',
      run: () => void window.open(fileUrl(path), '_blank', 'noopener'),
      why: path ? undefined : 'Not made yet',
    },
    { label: 'Copy path', run: copy, why: path ? undefined : 'Not made yet' },
    { label: 'Open folder', run: () => revealFile(client, path), why: path ? undefined : 'Not made yet' },
    ...extra,
    { label: 'Fix', run: onfix, why: notReady || (waiting ? undefined : 'Write a note first') },
    { label: 'OK', run: onok, why: notReady || undefined },
  ]);
</script>

<MoreMenu label={`More for ${item.label}`} {actions} />
