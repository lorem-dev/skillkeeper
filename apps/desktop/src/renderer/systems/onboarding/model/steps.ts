export type StepId =
  | 'welcome'
  | 'projects'
  | 'repositories'
  | 'skills-intro'
  | 'skills-actions'
  | 'agents'
  | 'done';

export type AnchorId = 'add-project' | 'add-repository';

export type StepKind = 'welcome' | 'spotlight' | 'modal';

export interface StepMeta {
  readonly kind: StepKind;
  /** Only for kind:'spotlight'. */
  readonly anchorId?: AnchorId;
}

export const STEP_META: Record<StepId, StepMeta> = {
  welcome: { kind: 'welcome' },
  projects: { kind: 'spotlight', anchorId: 'add-project' },
  repositories: { kind: 'spotlight', anchorId: 'add-repository' },
  'skills-intro': { kind: 'modal' },
  'skills-actions': { kind: 'modal' },
  agents: { kind: 'modal' },
  done: { kind: 'modal' },
};

/** The next step id in `order`, or null when `current` is the last step. */
export function nextStepId(order: readonly StepId[], current: StepId): StepId | null {
  const i = order.indexOf(current);
  if (i < 0 || i + 1 >= order.length) return null;
  return order[i + 1] ?? null;
}

/** The previous step id in `order`, or null when `current` is the first step. */
export function prevStepId(order: readonly StepId[], current: StepId): StepId | null {
  const i = order.indexOf(current);
  if (i <= 0) return null;
  return order[i - 1] ?? null;
}
