import { describe, it, expect } from 'vitest';
import { STEP_META, nextStepId, prevStepId } from './steps';
import type { StepId } from './steps';

const ORDER: readonly StepId[] = [
  'welcome', 'projects', 'repositories',
  'skills-intro', 'skills-actions', 'agents', 'done',
];

describe('steps', () => {
  it('advances to the next step', () => {
    expect(nextStepId(ORDER, 'welcome')).toBe('projects');
    expect(nextStepId(ORDER, 'agents')).toBe('done');
  });
  it('returns null past the last step', () => {
    expect(nextStepId(ORDER, 'done')).toBeNull();
  });
  it('retreats to the previous step', () => {
    expect(prevStepId(ORDER, 'projects')).toBe('welcome');
    expect(prevStepId(ORDER, 'done')).toBe('agents');
  });
  it('returns null before the first step', () => {
    expect(prevStepId(ORDER, 'welcome')).toBeNull();
  });
  it('spotlight steps carry an anchor', () => {
    expect(STEP_META.projects).toEqual({ kind: 'spotlight', anchorId: 'add-project' });
    expect(STEP_META.repositories.anchorId).toBe('add-repository');
    expect(STEP_META.welcome.kind).toBe('welcome');
  });
});
