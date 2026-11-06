import { isNotBuiltYet, type ServiceClient } from '../../lib/service/client';

const ANSWER_WITHIN_MS = 6000;

/**
 * Calls the service for things that may fail quietly: the screen keeps working without a draft, a live brief or
 * presets. A call that does not answer in time or fails gives undefined; one the service does not know yet is not
 * asked again. `only` limits which calls go out at all (demo states for screenshots).
 */
export class SoftService {
  readonly #client: ServiceClient;
  readonly #only: readonly string[] | null;
  readonly #unknown = new Set<string>();

  constructor(client: ServiceClient, only: readonly string[] | null = null) {
    this.#client = client;
    this.#only = only;
  }

  async call<T>(type: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    if (this.#unknown.has(type) || (this.#only && !this.#only.includes(type))) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ANSWER_WITHIN_MS);
    });
    try {
      return await Promise.race([this.#client.call<T>(type, params), late]);
    } catch (error) {
      if (isNotBuiltYet(error)) this.#unknown.add(type);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
