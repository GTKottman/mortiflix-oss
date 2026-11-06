import { bridgeUrl } from '../../lib/base';
import type { ServiceClient } from '../../lib/service/client';
import type { NewSource, TraySource } from '../../lib/source-tray';
import type { Problems } from '../../lib/stores/problems.svelte';
import { decodeTitle } from './entities';
import type { ServiceSource } from './types';

// The source tray's data: links and files of this draft, kept in step with the service.

interface AddReply {
  draft?: string;
  source: ServiceSource;
}

/** The part of the draft the tray needs: an id to put files under. */
export interface DraftLink {
  ensure: () => Promise<string>;
  adopt: (id: string) => void;
  readonly id: string | null;
}

const UPLOADING = 'tmp-';

export class TraySources {
  list = $state<ServiceSource[]>([]);
  readonly #client: ServiceClient;
  readonly #draft: DraftLink;
  readonly #problems: Problems;
  readonly #onchange: () => void;

  constructor(client: ServiceClient, draft: DraftLink, problems: Problems, onchange: () => void) {
    this.#client = client;
    this.#draft = draft;
    this.#problems = problems;
    this.#onchange = onchange;
  }

  /** Ids that go into the brief: finished, not failed. */
  get ids(): string[] {
    return this.list.filter((s) => !s.id.startsWith(UPLOADING) && s.status !== 'failed').map((s) => s.id);
  }

  get uploading(): boolean {
    return this.list.some((s) => s.id.startsWith(UPLOADING));
  }

  get items(): TraySource[] {
    return this.list.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: decodeTitle(s.label ?? s.name ?? s.url ?? ''),
      ...(s.url ? { url: s.url } : {}),
      ...(s.bytes ? { bytes: s.bytes } : {}),
      status: s.status,
      ...(s.status === 'failed'
        ? { text: s.error ?? s.status_text }
        : s.status_text
          ? { text: s.status_text }
          : {}),
    }));
  }

  /** Follows the service while a link is read; call the returned function to stop. */
  listen(): () => void {
    return this.#client.on<{ draft?: string; source?: ServiceSource; removed?: string } | undefined>(
      'sources.changed',
      (event) => {
        if (!event || event.draft !== this.#draft.id) return;
        const removed = event.removed;
        if (removed) this.list = this.list.filter((s) => s.id !== removed);
        else if (event.source) this.#upsert(event.source);
        this.#onchange();
      },
    );
  }

  replace(sources: ServiceSource[]): void {
    this.list = sources;
  }

  async add(source: NewSource): Promise<void> {
    if ('url' in source) await this.#addLink(source.url);
    else await this.#addFile(source.file);
  }

  async remove(id: string): Promise<void> {
    const gone = this.list.find((s) => s.id === id);
    this.list = this.list.filter((s) => s.id !== id);
    this.#onchange();
    const draft = this.#draft.id;
    if (!gone || !draft || id.startsWith(UPLOADING)) return;
    try {
      await this.#client.call('sources.remove', { draft, id });
    } catch (error) {
      this.#problems.raise({
        id: 'np-src',
        kind: 'warn',
        text: `Couldn't remove ${gone.label ?? gone.name ?? gone.url ?? 'that source'} on the service: ${error instanceof Error ? error.message : 'failed'}`,
      });
    }
  }

  async #addLink(url: string): Promise<void> {
    const draft = await this.#draft.ensure();
    const reply = await this.#client.call<AddReply>('sources.add', { draft, url });
    this.#draft.adopt(reply.draft ?? draft);
    this.#upsert(reply.source);
    this.#onchange();
  }

  /** A file that cannot be added stays in the tray as a failed chip with the reason, so it never throws. */
  async #addFile(file: File): Promise<void> {
    const temp: ServiceSource = {
      id: `${UPLOADING}${Math.random().toString(36).slice(2)}`,
      kind: 'file',
      label: file.name,
      name: file.name,
      bytes: file.size,
      status: 'fetching',
      status_text: 'Uploading…',
    };
    this.list = [...this.list, temp];
    this.#onchange();
    try {
      const draft = await this.#draft.ensure();
      const sent = await fetch(
        bridgeUrl(`/api/draft-upload?draft=${encodeURIComponent(draft)}&name=${encodeURIComponent(file.name)}`),
        {
          method: 'POST',
          body: file,
        },
      );
      if (!sent.ok) {
        if (sent.status === 404) throw new Error('Uploads are not switched on in this bridge yet');
        // The bridge answers {error} with its reason (403 cross-site / loopback only, 413 file too big, 400 bad draft
        // id or upload broke off): show it, not one word for all of them.
        const said = await sent
          .json()
          .then((body: { error?: unknown }) => (typeof body?.error === 'string' ? body.error : ''))
          .catch(() => '');
        throw new Error(`The upload failed: ${said || `the bridge answered ${sent.status}`}`);
      }
      const { path } = (await sent.json()) as { path: string };
      const reply = await this.#client.call<AddReply>('sources.add', { draft, path, name: file.name });
      this.list = this.list.filter((s) => s.id !== temp.id);
      // The service may already have told us the final status (sources.changed): that one is newer than this reply.
      if (!this.list.some((s) => s.id === reply.source.id)) this.#upsert(reply.source);
    } catch (error) {
      const why = error instanceof Error ? error.message : 'The upload failed';
      this.list = this.list.map((s) => (s.id === temp.id ? { ...s, status: 'failed', error: why } : s));
    }
    this.#onchange();
  }

  #upsert(source: ServiceSource): void {
    const at = this.list.findIndex((s) => s.id === source.id);
    this.list = at >= 0 ? this.list.map((s, i) => (i === at ? source : s)) : [...this.list, source];
  }
}
