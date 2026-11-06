import { SvelteURLSearchParams } from 'svelte/reactivity';

// A tiny hash router: /app/#/motion, /app/#/kit, /app/#/settings?tab=review. Hash routes need no bridge changes
// and Back works by itself.

export class Router {
  path = $state('/');
  query = $state(new SvelteURLSearchParams());

  constructor() {
    this.#read();
    window.addEventListener('hashchange', () => this.#read());
  }

  go(path: string): void {
    location.hash = path;
  }

  #read(): void {
    const [path = '', query = ''] = location.hash.replace(/^#/, '').split('?');
    this.path = path || '/';
    this.query = new SvelteURLSearchParams(query);
  }
}

/** The href for an app route. */
export const routeHref = (path: string): string => `#${path}`;
