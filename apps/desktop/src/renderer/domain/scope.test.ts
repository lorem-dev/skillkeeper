import { describe, expect, it } from 'vitest';
import type { AgentTarget, Project } from '@/services/bridge';
import { GLOBAL_SCOPE_ID, applyScope, isGlobalScope, scopeIdOf } from './scope';

const projects: Project[] = [
  { id: 'p1', path: '/work/one', name: 'One', addedAt: '2026-01-01T00:00:00.000Z' },
];

const target = (patch: Partial<AgentTarget>): AgentTarget => ({
  agent: 'claude',
  scope: 'project',
  ...patch,
});

describe('isGlobalScope', () => {
  it('recognizes the reserved id and nothing else', () => {
    expect(isGlobalScope(GLOBAL_SCOPE_ID)).toBe(true);
    expect(isGlobalScope('p1')).toBe(false);
    expect(isGlobalScope('')).toBe(false);
  });
});

describe('applyScope', () => {
  it('maps the global id onto the global scope with no project fields', () => {
    expect(applyScope(GLOBAL_SCOPE_ID, projects)).toEqual({
      scope: 'global',
      projectId: '',
      projectPath: '',
    });
  });

  it('maps a tracked project onto its id and path', () => {
    expect(applyScope('p1', projects)).toEqual({
      scope: 'project',
      projectId: 'p1',
      projectPath: '/work/one',
    });
  });

  it('returns null for an id that is neither', () => {
    expect(applyScope('gone', projects)).toBeNull();
  });
});

describe('scopeIdOf', () => {
  it('buckets a global target under the reserved id', () => {
    expect(scopeIdOf(target({ scope: 'global' }))).toBe(GLOBAL_SCOPE_ID);
  });

  it('uses the project id for a project target', () => {
    expect(scopeIdOf(target({ projectId: 'p1' }))).toBe('p1');
  });

  it('is undefined for a project target with no id', () => {
    expect(scopeIdOf(target({}))).toBeUndefined();
  });
});
