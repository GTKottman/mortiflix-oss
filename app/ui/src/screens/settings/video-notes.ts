import type { TabletAddress } from './types';

// Words for the Video Notes section.

const MINUTE = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 1440;

/** "just now (14:02)", "5 min ago (14:02)", "3 h ago (11:02)", or the date once it is over a day. */
export function ago(iso: string, now = Date.now()): string {
  const then = new Date(iso);
  const minutes = Math.max(0, Math.round((now - then.getTime()) / MINUTE));
  const time = then.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const how =
    minutes < 1
      ? 'just now'
      : minutes < HOUR_MINUTES
        ? `${minutes} min ago`
        : minutes < DAY_MINUTES
          ? `${Math.round(minutes / HOUR_MINUTES)} h ago`
          : then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${how} (${time})`;
}

/** The folder path in the owner's words: "Morti Drive › Video Notes". */
export function folderWords(folder: string): string {
  const match = folder.match(/MortiDrive\/files\/(.+)$/);
  return match?.[1] ? `Morti Drive › ${match[1].split('/').join(' › ')}` : folder;
}

/** Names the addresses: Tailscale, Home network, Home network (2nd). */
export function labelled(addresses: readonly TabletAddress[]): { label: string; address: TabletAddress }[] {
  let locals = 0;
  return addresses.map((address) => ({
    address,
    label:
      address.label ||
      (address.kind === 'tailscale' ? 'Tailscale' : locals++ ? 'Home network (2nd)' : 'Home network'),
  }));
}
