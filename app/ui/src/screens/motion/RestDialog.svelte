<!-- Make the remaining scenes at once: the service's warning, what it means, and "One at a time" as the default. -->
<script lang="ts">
  import { plural } from '../../lib/words';
  import Button from '../../lib/components/Button.svelte';
  import DialogFacts from './DialogFacts.svelte';
  import DialogRemark from './DialogRemark.svelte';
  import MotionDialog from './MotionDialog.svelte';
  import { useMotion } from './motion.svelte';

  const motion = useMotion();

  const DEFAULT_WARNING =
    'Scenes made ahead of time will not have the lessons from notes you have not given yet. Every one you do not like has to be fixed after.';

  /** 1-based numbers of the scenes still waiting to be made. */
  const waiting = $derived(motion.scenes.flatMap((scene, i) => (scene.state === 'waiting' ? [i + 1] : [])));
  const left = $derived(motion.rest?.rest ?? waiting.length);
  const which = $derived(
    waiting.length === 1
      ? `scene ${waiting[0]}`
      : waiting.length > 1
        ? `scenes ${waiting[0]}–${waiting.at(-1)}`
        : 'the scenes not made yet',
  );
  const rows = $derived([
    {
      term: 'Scope',
      detail: `${plural(left, 'scene')}: ${which}, all made together.`,
    },
    {
      term: 'Lessons',
      detail: `Only the ${plural(motion.lessonsUsed, 'lesson')} approved so far. Nothing from later notes.`,
    },
    { term: 'Time', detail: 'Not known yet: it depends on how many scenes run together.' },
    { term: 'Cost', detail: 'No ElevenLabs credits. It uses your Claude plan, once per scene.' },
  ]);
</script>

<MotionDialog title="Make the remaining scenes at once?" onclose={() => (motion.rest = null)}>
  <DialogRemark tone="warn">{motion.rest?.warning || DEFAULT_WARNING}</DialogRemark>
  <DialogFacts {rows} />
  {#snippet actions(close)}
    <Button variant="primary" onclick={close}>One at a time (recommended)</Button>
    <Button
      variant="cost"
      onclick={() => {
        close();
        void motion.makeRest();
      }}>Make all {left} anyway</Button
    >
  {/snippet}
</MotionDialog>
