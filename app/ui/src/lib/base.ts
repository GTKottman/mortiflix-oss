// Where the bridge is, as seen by this page: '' when the page is the bridge's own /app/, or the prefix a host puts in
// front of it (Morti Drive serves the app at /studio/app/ and passes /studio/* on to the bridge).
export const BASE = typeof location === 'undefined' ? '' : location.pathname.replace(/\/app(\/.*)?$/, '');

/** A bridge address (`/file?...`, `/api/...`, `/ws`) under that prefix. */
export const bridgeUrl = (path: string): string => `${BASE}${path}`;
