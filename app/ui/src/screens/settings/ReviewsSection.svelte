<!-- Reviews: how much Claude offers at each review. Three steppers, saved at once. -->
<script lang="ts">
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import { isNotBuiltYet } from '../../lib/service/client';
  import { useApp } from '../../lib/stores/context';
  import { REVIEW_SETTINGS, type ReviewSetting } from './reviews';
  import SettingsSection from './SettingsSection.svelte';
  import Stepper from './Stepper.svelte';

  const { client, settings } = useApp();

  /** The service has no Settings keys yet: the steppers show the defaults and say so. */
  let soon = $state(false);
  let failure = $state<string | null>(null);

  async function change(setting: ReviewSetting, value: number) {
    if (value < setting.min || value > setting.max) return;
    const before = settings.value;
    const wrote = setting.write(before, value);
    settings.value = wrote;
    try {
      await client.call('settings.set', setting.request(value));
      failure = null;
    } catch (error) {
      // A later change may already be on screen; only undo this one.
      if (settings.value === wrote) settings.value = before;
      if (isNotBuiltYet(error)) soon = true;
      else failure = `Not saved: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }
</script>

<SettingsSection title="Reviews" lede="How much Claude offers you at each review. Changes are saved at once.">
  {#if settings.error}
    <ErrorState
      inline
      title="Couldn't read these"
      detail={settings.error}
      onretry={() => void settings.load()}
    />
  {:else}
    {#each REVIEW_SETTINGS as setting (setting.id)}
      <Stepper
        label={setting.label}
        help={setting.help}
        value={setting.read(settings.value)}
        min={setting.min}
        max={setting.max}
        disabled={soon}
        onchange={(value) => change(setting, value)}
      />
    {/each}
  {/if}
  {#if soon}
    <p class="why">These settings arrive in this build. The numbers shown are the defaults.</p>
  {/if}
  {#if failure}
    <ErrorState inline title="Couldn't save that" detail={failure} />
  {/if}
</SettingsSection>

<style>
  .why {
    color: var(--muted);
    font-size: var(--t13);
  }
</style>
