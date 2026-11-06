import type { ReviewService } from './types';

/** Reloads a screen's data when the service says it changed (events), a little later so bursts count once.
 *  Also reloads when the bridge comes back. Call it while a component is being made. */
export function useLiveReload(
  service: ReviewService,
  events: readonly string[],
  load: () => Promise<void>,
): void {
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void load();
      }, 250);
    };
    const stops = events.map((event) => service.on(event, soon));
    stops.push(
      service.on<{ up: boolean }>('bridge.state', (state) => {
        if (state.up) void load();
      }),
    );
    return () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  });
}
