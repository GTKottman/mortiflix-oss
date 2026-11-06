// The shapes Home reads from `project.list` and the `project.changed` event. Field names are the service's.

import type { NeedsYou } from '../../lib/service/types';

export type { NeedsYou };

export interface Pipeline {
  slug?: string;
  stage_set?: string;
}

export interface HomeProject {
  id: string;
  title: string;
  state?: string;
  /** The service's stage number; `screenOf` turns it into a screen. */
  stage: number;
  delivered?: boolean;
  pipeline?: Pipeline | string;
  set?: string;
  updated_at?: string;
  created_at?: string;
  needs_you?: NeedsYou | null;
}

/** `/api/stills`: a path to the project's first still, or an object with its address. */
export type Still = string | { url: string };

export interface ProjectChange {
  id: string;
  state?: string;
  stage?: number;
  delivered?: boolean;
  needs_you?: NeedsYou | null;
}

export type Group = 'needs' | 'making' | 'done';
