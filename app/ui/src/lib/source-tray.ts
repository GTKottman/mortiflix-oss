// What the source tray holds and the rules it follows: a source's status in words, which links and files it takes.

export type TraySourceStatus = 'fetching' | 'ready' | 'stored' | 'failed';

export interface TraySource {
  id: string;
  /** "url", "pdf", "image"… shown as a small label. */
  kind: string;
  label: string;
  url?: string;
  bytes?: number;
  status: TraySourceStatus;
  /** The service's words for the status; failed ones say why. */
  text?: string;
}

export type NewSource = { url: string } | { file: File };

const STATUS_WORDS: Record<TraySourceStatus, string> = {
  fetching: 'Reading…',
  ready: 'Read',
  stored: 'Kept as it is',
  failed: 'Could not read this',
};

export const formatSize = (bytes: number): string =>
  bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/** What the status column says for one source. */
export function statusText(source: TraySource): string {
  if (source.text) return source.text;
  const words = STATUS_WORDS[source.status];
  return source.status !== 'failed' && source.bytes ? `${words} · ${formatSize(source.bytes)}` : words;
}

/** Why a pasted link cannot be added, or null when it can. */
export function linkProblem(text: string, sources: readonly TraySource[]): string | null {
  if (!/^https?:\/\/\S+$/.test(text)) return 'A link starts with http:// or https://';
  if (sources.some((s) => s.url === text)) return 'That link is already in the tray.';
  return null;
}

/** A file already in the tray (same name and size) is not added twice. */
export const isInTray = (file: File, sources: readonly TraySource[]): boolean =>
  sources.some((s) => s.label === file.name && s.bytes === file.size);
