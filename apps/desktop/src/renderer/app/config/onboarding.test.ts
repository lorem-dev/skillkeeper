import { describe, it, expect } from 'vitest';
import { ONBOARDING_ORDER, STEP_VIEW } from './onboarding';

describe('onboarding config', () => {
  it('starts at welcome and ends at done', () => {
    expect(ONBOARDING_ORDER[0]).toBe('welcome');
    expect(ONBOARDING_ORDER[ONBOARDING_ORDER.length - 1]).toBe('done');
  });
  it('maps every ordered step to a view', () => {
    for (const step of ONBOARDING_ORDER) {
      expect(STEP_VIEW[step]).toBeTypeOf('string');
    }
  });
});
