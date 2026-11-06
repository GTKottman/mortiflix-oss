<!-- The stage's own ⋯ in the screen head: the screen's extra items (e.g. "Mix the sounds again"), "Edit the brief…"
     where the stage has one, and "Reopen this step…" (an OK'd step) or "Make it again…" (a step in review). The
     items open one panel under the head (StagePanel); nothing is changed until the owner confirms there. -->
<script lang="ts">
  import { demoStatuses } from '../stage-demo';
  import { stageActions } from '../stage-tools.svelte';
  import { stageById, type StageId } from '../stages';
  import { useProject } from '../stores/context';
  import MoreMenu, { type MenuAction } from './MoreMenu.svelte';

  interface Props {
    stage: StageId;
    /** The stage has a brief (Look, Motion): "Edit the brief…" opens it. */
    brief?: boolean;
    /** Screen items first. */
    extra?: readonly MenuAction[];
  }

  let { stage, brief = false, extra = [] }: Props = $props();

  const project = useProject();
  const actions = $derived<MenuAction[]>([
    ...extra,
    ...stageActions(stage, brief, demoStatuses(project.statuses)),
  ]);
</script>

<MoreMenu label={`More for ${stageById(stage).label}`} {actions} />
