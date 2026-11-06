import { isNotBuiltYet, type ServiceClient } from '../service/client';
import type { StudioSettings } from '../service/types';

// The owner's Settings choices the shared pieces need (e.g. how many options to see). Defaults until loaded.

export const DEFAULT_SETTINGS: StudioSettings = {
  options: { count: 4 },
  review: { framesPerRound: 3, scenesPerGroup: 1 },
};

export class Settings {
  value = $state<StudioSettings>(DEFAULT_SETTINGS);
  /** Why the last read failed, or null. The defaults stay in `value` meanwhile. */
  error = $state<string | null>(null);
  readonly #client: ServiceClient;

  constructor(client: ServiceClient) {
    this.#client = client;
    client.on<unknown>('settings.changed', (settings) => (this.value = withDefaults(settings)));
  }

  get optionsCount(): number {
    return this.value.options.count;
  }

  /** Keeps the defaults when the service has no settings yet or cannot be read; a failed read sets `error`. */
  async load(): Promise<void> {
    try {
      this.value = withDefaults(await this.#client.call<unknown>('settings.get'));
      this.error = null;
    } catch (error) {
      this.error = isNotBuiltYet(error) ? null : error instanceof Error ? error.message : 'unknown error';
    }
  }
}

/** The service's answer over the defaults, part by part: an older or partial answer (no `options`) cannot leave a
 * hole that throws in a reader such as `optionsCount`. */
function withDefaults(raw: unknown): StudioSettings {
  const given = (raw && typeof raw === 'object' ? raw : {}) as Partial<StudioSettings>;
  const part = <T extends object>(value: unknown, fallback: T): T =>
    value && typeof value === 'object' ? { ...fallback, ...(value as Partial<T>) } : { ...fallback };
  return {
    ...given,
    options: part(given.options, DEFAULT_SETTINGS.options),
    review: part(given.review, DEFAULT_SETTINGS.review),
  };
}
