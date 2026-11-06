<!-- Settings: Writing (Claude Code), Voice (ElevenLabs key, daily credit cap), Video Notes (opt-in tablet review),
     Home network (opt-in access from other devices), Reviews, and the other connections. First run adds a welcome line and "Done, start making". -->
<script lang="ts">
  import ScreenHead from '../../lib/components/ScreenHead.svelte';
  import { useApp } from '../../lib/stores/context';
  import FirstRunBar from './FirstRunBar.svelte';
  import HomeNetworkSection from './HomeNetworkSection.svelte';
  import OtherSection from './OtherSection.svelte';
  import ReviewsSection from './ReviewsSection.svelte';
  import { SettingsPage } from './settings-page.svelte';
  import type { AccessSettings } from './types';
  import VideoNotesSection from './VideoNotesSection.svelte';
  import VoiceSection from './VoiceSection.svelte';
  import WritingSection from './WritingSection.svelte';

  const { client, router } = useApp();
  // Home's "Add key" arrives with ?focus=voice; ?first shows the first-run page.
  const page = new SettingsPage(client, router.query.has('first'));
  const focusVoice = router.query.get('focus') === 'voice';

  let finishing = $state(false);
  let saveError = $state<string | null>(null);
  /** Done was pressed while Writing is not ready: say so once; the second press (Start anyway) goes on. */
  let writingWarned = $state(false);
  const writingWait = $derived(writingWarned && !page.writingReady);

  const mark = (ready: boolean): string => (ready ? '✓' : '○');
  const summary = $derived(
    saveError ??
      (writingWait
        ? 'Writing is not ready: connect Claude Code above. Without it no brief or script can be written.'
        : null) ??
      `Writing ${mark(page.writingReady)} · Voice ${mark(page.voiceKeySet)} · Video Notes ${mark(!!page.videoNotes?.enabled)}`,
  );

  $effect(() => {
    if (client.up) page.start();
    return client.on<{ up: boolean }>('bridge.state', (state) => state.up && page.start());
  });
  $effect(() => client.on('videonotes.changed', () => void page.loadVideoNotes()));
  $effect(() => client.on<AccessSettings>('settings.changed', (settings) => page.applyAccess(settings)));
  $effect(() => {
    const again = () => {
      if (!document.hidden) void page.loadVideoNotes();
    };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  });

  // A failed save stays here and says why; the button then starts anyway (the first-run page may come back).
  async function done() {
    if (saveError) {
      router.go('/');
      return;
    }
    if (!page.writingReady && !writingWarned) {
      writingWarned = true;
      return;
    }
    finishing = true;
    const why = await page.finish();
    finishing = false;
    if (why) saveError = `Couldn't save the setup: ${why}. This page may show again next time.`;
    else router.go('/');
  }
</script>

<ScreenHead
  kicker={page.firstRun ? 'Welcome' : 'Settings'}
  title={page.firstRun ? 'Let’s get you set up' : 'Settings'}
  help={page.firstRun
    ? 'Writing is needed. Voice and Video Notes are optional; you can change them later here.'
    : undefined}
/>
<div class="sections">
  <WritingSection {page} />
  <VoiceSection {page} focusKey={focusVoice} />
  <VideoNotesSection {page} />
  <HomeNetworkSection {page} />
  <ReviewsSection />
  <OtherSection {page} />
</div>
{#if page.firstRun}
  <FirstRunBar
    note={finishing ? 'Saving…' : summary}
    busy={finishing}
    label={saveError || writingWait ? 'Start anyway' : 'Done, start making'}
    ondone={done}
  />
{/if}

<style>
  .sections {
    display: grid;
    align-content: start;
  }
</style>
