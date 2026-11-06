import type { MenuAction } from './components/MoreMenu.svelte';
import type { StageStatus, StepState } from './service/types';
import { stageById, statusFor, type Stage, type StageId } from './stages';

// The stage's own ⋯ items (StageMenu) and the one inline panel they open under the screen head (StagePanel):
// edit the Look or Motion brief, reopen an OK'd step (stage.reopen), make a step in review again
// (review.respond changes). One screen is on view at a time, so one panel state serves the app.

/** What the panels call: the service, or a screen's fixture (screenshots never reach the real service). */
export interface Caller {
  call<T>(type: string, params?: Record<string, unknown>): Promise<T>;
}

export type PanelKind = 'brief' | 'reopen' | 'remake' | 'use-look';

export interface OpenPanel {
  kind: PanelKind;
  stage: StageId;
  /** use-look: the frame to use. */
  frame?: string;
}

class StagePanelState {
  open = $state<OpenPanel | null>(null);

  show(panel: OpenPanel): void {
    this.open = panel;
  }

  close(): void {
    this.open = null;
  }

  /** The panel open on this stage's screen, if any. */
  on(stage: StageId): OpenPanel | null {
    return this.open?.stage === stage ? this.open : null;
  }
}

export const stagePanel = new StagePanelState();

/** The service states of an OK'd step: it can be reopened. */
const SETTLED = ['approved', 'done'];

/** What going back on this stage does: reopen its last OK'd step, or make the step in review again. */
export type GoBack = { kind: 'reopen' | 'remake'; step: StepState; key: string } | null;

export function goBackOf(stage: Stage, statuses: readonly StageStatus[]): GoBack {
  const status = statusFor(stage, statuses);
  const steps = status?.steps ?? [];
  const settled = steps.filter((step) => SETTLED.includes(step.state)).at(-1);
  if (settled && status) return { kind: 'reopen', step: settled, key: status.key };
  const review = steps.find((step) => step.state === 'in_review');
  if (review && status) return { kind: 'remake', step: review, key: status.key };
  return null;
}

export const GO_BACK_LABEL = { reopen: 'Reopen this step…', remake: 'Make it again…' } as const;

/** The stage's own menu items: "Edit the brief…" where it has one, then reopen / make again. */
export function stageActions(id: StageId, brief: boolean, statuses: readonly StageStatus[]): MenuAction[] {
  const back = goBackOf(stageById(id), statuses);
  const list: MenuAction[] = [];
  if (brief)
    list.push({ label: 'Edit the brief…', run: () => stagePanel.show({ kind: 'brief', stage: id }) });
  list.push(
    back
      ? { label: GO_BACK_LABEL[back.kind], run: () => stagePanel.show({ kind: back.kind, stage: id }) }
      : {
          label: GO_BACK_LABEL.reopen,
          run: () => undefined,
          why: 'Nothing in this step is made or OK’d yet',
        },
  );
  return list;
}

/** The steps that spend ElevenLabs when they run (service src/svc/paidgate.mjs PAID_STEPS). */
export const PAID_STEPS = ['voice', 'music', 'sound'] as const;

export const isPaidStep = (key: string): boolean => (PAID_STEPS as readonly string[]).includes(key);
