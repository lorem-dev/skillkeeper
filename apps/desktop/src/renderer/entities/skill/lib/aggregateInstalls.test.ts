import { describe, it, expect } from 'vitest';
import type { InstallManifest } from '@/services/bridge';
import { aggregateInstalls } from './aggregateInstalls';

function mk(over: Partial<InstallManifest> & { name: string }): InstallManifest {
  return {
    skillId: { name: over.name, ...(over.skillId?.group ? { group: over.skillId.group } : {}) },
    target: over.target ?? { agent: 'claude', scope: 'global' },
    destinationRoot: over.destinationRoot ?? '/d',
    installedAt: over.installedAt ?? '2026-01-01T00:00:00.000Z',
    files: over.files ?? [],
    hookEdits: over.hookEdits ?? [],
    ...(over.version ? { version: over.version } : {}),
    ...(over.sourceRepoId ? { sourceRepoId: over.sourceRepoId } : {}),
  };
}

describe('aggregateInstalls', () => {
  it('groups installs of the same skill across agents and de-dupes/sorts agents', () => {
    const out = aggregateInstalls([
      mk({ name: 'a', target: { agent: 'codex', scope: 'global' } }),
      mk({ name: 'a', target: { agent: 'claude', scope: 'project', projectId: 'p' } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.agents).toEqual(['claude', 'codex']);
    expect(out[0]!.scopes.sort()).toEqual(['global', 'project']);
  });

  it('keeps the latest installedAt and detects hooks', () => {
    const out = aggregateInstalls([
      mk({ name: 'a', installedAt: '2026-01-01T00:00:00.000Z' }),
      mk({ name: 'a', installedAt: '2026-03-01T00:00:00.000Z',
           hookEdits: [{ kind: 'file', relPath: 'h', sha256: 'x', executable: false }] }),
    ]);
    expect(out[0]!.installedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(out[0]!.hasHooks).toBe(true);
  });

  it('uses a group/name key for grouped skills and exposes the group', () => {
    const out = aggregateInstalls([mk({ name: 'api-helper', skillId: { group: 'web', name: 'api-helper' } })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe('web/api-helper');
    expect(out[0]!.group).toBe('web');
    expect(out[0]!.name).toBe('api-helper');
  });

  it('sums file and hook counts across installs of the same skill', () => {
    const file = { relPath: 'f', sha256: 'x', executable: false };
    const hook = { kind: 'file' as const, relPath: 'h', sha256: 'y', executable: false };
    const out = aggregateInstalls([
      mk({ name: 'a', files: [file, file], hookEdits: [hook] }),
      mk({ name: 'a', target: { agent: 'codex', scope: 'global' }, files: [file], hookEdits: [hook] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.fileCount).toBe(3);
    expect(out[0]!.hookCount).toBe(2);
  });

  it('returns an empty array for empty input', () => {
    expect(aggregateInstalls([])).toEqual([]);
  });
});
