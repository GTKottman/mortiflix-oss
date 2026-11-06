<!-- The ⋯ menu for the scene on view, next to Previous / Next: open or copy its clip, open its folder, send it to the tablet again,
     and Request fix / Approve (the same as the decision bar, which still asks first); then the Motion step's own items
     (Edit the brief…, Reopen this step… / Make it again…). -->
<script lang="ts">
  import MoreMenu, { type MenuAction } from '../../lib/components/MoreMenu.svelte';
  import { revealFile } from '../../lib/files';
  import { demoStatuses } from '../../lib/stage-demo';
  import { stageActions } from '../../lib/stage-tools.svelte';
  import { useProject, useService } from '../../lib/stores/context';
  import { clipUrl } from './media';
  import { useMotion } from './motion.svelte';

  const motion = useMotion();
  const client = useService();
  const project = useProject();

  const path = $derived(motion.media.path ?? '');
  const notYet = $derived(path ? undefined : 'Nothing made yet');
  const decideWhy = $derived(motion.canDecide ? undefined : motion.busy || 'Not ready to decide yet');

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
      label: 'Open in a new tab',
      run: () => void window.open(clipUrl(path), '_blank', 'noopener'),
      why: notYet,
    },
    { label: 'Copy path', run: copy, why: notYet },
    { label: 'Open folder', run: () => revealFile(client, path), why: notYet },
    {
      label: `Send scene ${motion.index + 1} to the tablet again`,
      run: async () => {
        await motion.sendSceneToTablet();
        return 'Sent to the tablet.';
      },
      why: motion.tabletLine?.menu ? undefined : 'The tablet is not set up',
    },
    {
      label: 'Request fix…',
      run: () => motion.askFix(),
      why: decideWhy ?? (motion.unresolved.length ? undefined : 'Write a note first'),
    },
    { label: 'Approve scene…', run: () => motion.askApprove(), why: decideWhy },
    // the Motion step itself: its brief, reopen it / make it again
    ...stageActions('motion', true, demoStatuses(project.statuses)),
  ]);
</script>

<MoreMenu label={`More for scene ${motion.index + 1}`} {actions} />
