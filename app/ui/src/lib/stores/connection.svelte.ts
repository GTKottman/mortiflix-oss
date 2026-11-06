import { bridgeUrl } from '../base';
import type { BridgeState, LinkState, ServiceClient } from '../service/client';
import type { Problems } from './problems.svelte';

// The link to the service. It reconnects by itself and nothing shows while that works (owner: status only on
// errors). Only when it is still broken after 30 s does the Fix it strip say so.

const GRACE_MS = 30_000;

export class Connection {
  up = $state(false);
  link = $state<LinkState>('ok');
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Broken for longer than the grace time: the strip shows it and follows each change at once. */
  #late = false;

  constructor(client: ServiceClient, problems: Problems, { graceMs = GRACE_MS }: { graceMs?: number } = {}) {
    client.on<BridgeState>('bridge.state', (state) => (this.up = state.up));
    client.on<LinkState>('link', (link) => {
      this.link = link;
      if (link === 'ok') {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#late = false;
        problems.clear('link');
        return;
      }
      if (this.#late) {
        problems.raise(linkProblem(link));
        return;
      }
      // The grace time counts from the first break, not from the last flip: a link that keeps flipping between
      // lost and restarting is still broken and must reach the strip.
      this.#timer ??= setTimeout(() => {
        this.#timer = undefined;
        if (this.link === 'ok') return;
        this.#late = true;
        problems.raise(linkProblem(this.link));
      }, graceMs);
    });
  }
}

function linkProblem(link: Exclude<LinkState, 'ok'>) {
  return {
    id: 'link',
    kind: 'bad' as const,
    text:
      link === 'lost'
        ? 'Lost the connection to Mortiflix. It keeps trying. What you do now is sent when it is back.'
        : 'Mortiflix did not come back after restarting.',
    fix: {
      run: async () => {
        if (link === 'restart') {
          const answer = await fetch(bridgeUrl('/api/service/restart'), { method: 'POST' }).catch(() => null);
          // bridge.mjs restartService: {restarting:true, pid} or {restarting:false, reason} (service already down,
          // the bridge is starting it again). Only the first is a restart.
          const body = (answer?.ok ? await answer.json().catch(() => null) : null) as
            | { restarting?: unknown; reason?: unknown }
            | null;
          if (body?.restarting === true) return 'Restarted the Mortiflix service. Your text is kept.';
          if (body?.restarting === false && typeof body.reason === 'string') return body.reason;
        }
        setTimeout(() => location.reload(), 400);
        return 'Reconnecting…';
      },
    },
  };
}
