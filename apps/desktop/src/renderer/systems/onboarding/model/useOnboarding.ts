import { useSkillkeeperStore } from '@/app/store';
import type { StepId } from './steps';

/** Whether the guided onboarding tour is currently active. */
export function useOnboardingActive(): boolean {
  return useSkillkeeperStore((s) => s.onboarding.active);
}

/** The onboarding tour's current step id. */
export function useOnboardingStep(): StepId {
  return useSkillkeeperStore((s) => s.onboarding.step);
}

/** The onboarding tour's lifecycle actions. */
export function useOnboardingActions(): {
  start: () => void;
  next: () => void;
  back: () => void;
  skip: () => void;
  finish: () => void;
} {
  const start = useSkillkeeperStore((s) => s.startOnboarding);
  const next = useSkillkeeperStore((s) => s.nextOnboardingStep);
  const back = useSkillkeeperStore((s) => s.prevOnboardingStep);
  const skip = useSkillkeeperStore((s) => s.skipOnboarding);
  const finish = useSkillkeeperStore((s) => s.finishOnboarding);
  return { start, next, back, skip, finish };
}
