/** Keeps the selected line or cue in the page address (?line=… / ?cue=…) so a reload comes back to it. */
export function rememberSelection(line: string | null, cue: string | null): void {
  const url = new URL(location.href);
  const [path = '', query = ''] = url.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  for (const [name, value] of [
    ['line', line],
    ['cue', cue],
  ] as const) {
    if (value) params.set(name, value);
    else params.delete(name);
  }
  url.hash = params.size ? `${path}?${params}` : path;
  history.replaceState(null, '', url);
}
