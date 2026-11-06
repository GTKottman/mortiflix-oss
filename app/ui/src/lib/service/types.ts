// Shapes of the service answers the shared pieces read. Field names are the service's (snake_case).

/** One entry of `stage.status`. */
export interface StageStatus {
  key: string;
  set?: string;
  kind?: 'done' | 'making' | string;
  /** Pieces made (or steps reached). Never what the owner OK'd: that is `ok`. */
  done?: number;
  /** Pieces the owner OK'd (or steps approved). Missing from an older service. */
  ok?: number;
  total?: number;
  text?: string;
  /** Pieces and questions waiting for the owner's OK. */
  need?: number;
  /** The pipeline steps in this stage, in order. */
  steps?: StepState[];
}

/** One pipeline step as `stage.status` lists it. `state` is the service's: working, in_review, changes, approved, done, ready, blocked. */
export interface StepState {
  key: string;
  name: string;
  state: string;
  version?: number;
}

/** Why a project waits (`project.needs_you`). `cause` is login, billing, gpu, rate-limit, gave-up, needs-ai, stopped; none = see `text`. */
export interface NeedsYou {
  text?: string;
  at?: string;
  cause?: string;
  takeover?: boolean;
  by_you?: boolean;
  /** 'cost_ok': a paid step waits for the owner's OK on its cost (`step.confirm_cost`). */
  kind?: string;
  step?: string;
  estimate_credits?: number | null;
  voice?: CostVoice | null;
}

/** The voice a cost OK names: the project's narrator (`from: 'cast'`) or the studio voice. */
export interface CostVoice {
  id?: string | null;
  name?: string | null;
  model?: string | null;
  from?: 'cast' | 'studio';
}

/** `step.cost`: what a paid step would spend if it started now, and the owner's OK on it. */
export interface StepCost {
  step: string;
  estimate_credits: number | null;
  free: boolean;
  characters?: number;
  lines?: number;
  voice: CostVoice | null;
  ok_now?: boolean;
  ask_first: boolean;
  waiting: boolean;
}

export interface ProjectSummary {
  id: string;
  title?: string;
  state?: string | null;
  needs_you?: NeedsYou | null;
}

/** `state.get` */
export interface ServiceState {
  project?: string | null;
  state?: string | null;
  needs_you?: NeedsYou | null;
}

/** `settings.get` / event `settings.changed` */
export interface StudioSettings {
  options: { count: number };
  review: { framesPerRound: number; scenesPerGroup: number };
}

/** What a paid step will spend, shown before it runs. */
export interface Cost {
  what: string;
  amount: string;
  note?: string;
}

/** One Claude-made option from `options.get`. */
export interface StudioOption {
  id: string;
  label: string;
  does: string;
  cost?: Cost | null;
}

/** An open question Claude asks, answered with one click. */
export interface StudioQuestion {
  id: string;
  text: string;
  choices: string[];
  default?: string | null;
}

export interface OptionsResult {
  options: StudioOption[];
  questions?: StudioQuestion[];
}

/** `options.run`: either it ran (`does` says what was done) or it asks first (`asked` + `text`). */
export interface OptionRunResult {
  does?: string;
  asked?: boolean;
  text?: string;
}
