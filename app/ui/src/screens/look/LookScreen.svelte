<!-- Look (stage 3): the style frames. ONE frame in review, big; the owner checks off each (Enter = OK, F = Fix).
     Frames come in rounds of 3 and what the notes teach goes into the frames after. This part finds the service
     (the real one, or the screenshot fixture when the address has ?fixture=review) and hands it on. -->
<script lang="ts">
  import ErrorState from '../../lib/components/ErrorState.svelte';
  import LoadingState from '../../lib/components/LoadingState.svelte';
  import { reviewService } from '../../lib/review/fixture';
  import { useRouter, useService } from '../../lib/stores/context';
  import LookReview from './LookReview.svelte';

  const router = useRouter();
  const fixture = import.meta.env.DEV ? router.query.get('fixture') : null; // fixtures: dev builds only
  const ready = reviewService('frames', fixture, useService());
</script>

{#await ready}
  <LoadingState text="Loading the frames…" />
{:then service}
  <LookReview {service} {fixture} />
{:catch error}
  <ErrorState
    title="Couldn't open the screenshot fixture"
    detail={error instanceof Error ? error.message : ''}
  />
{/await}
