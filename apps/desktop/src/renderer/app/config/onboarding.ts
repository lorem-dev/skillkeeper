import type { StepId } from '@/systems/onboarding';
import type { View } from '../navigation';

/** The onboarding step sequence (app-owned; the system owns per-step UI meta). */
export const ONBOARDING_ORDER: readonly StepId[] = [
  'welcome',
  'projects',
  'repositories',
  'agents',
  'skills-intro',
  'skills-actions',
  'done',
];

/** Which app view to force behind the overlay while each step is shown. */
export const STEP_VIEW: Record<StepId, View> = {
  welcome: 'projects',
  projects: 'projects',
  repositories: 'repositories',
  'skills-intro': 'skills-management',
  'skills-actions': 'skills-management',
  agents: 'skills-management',
  done: 'projects',
};
