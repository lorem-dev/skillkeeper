import { describe, it, expect } from 'vitest';
import type { AgentKind, InstallManifest } from '@/services/bridge';
import { GLOBAL_SCOPE_ID } from '@/domain';
import { buildProjectPlan } from './applyPlan';
import { projectSkillKey } from './skillTree';

/** Build a project-scoped install manifest. `remote` mirrors `.skid.yml` identity. */
function mk(over: {
  projectId: string;
  name: string;
  agent: AgentKind;
  repoId: string;
  remote?: string;
  group?: string;
}): InstallManifest {
  return {
    skillId: { name: over.name, ...(over.group ? { group: over.group } : {}) },
    target: { agent: over.agent, scope: 'project', projectId: over.projectId },
    destinationRoot: '/d',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [],
    hookEdits: [],
    sourceRepoId: over.repoId,
    ...(over.remote ? { sourceRemote: over.remote } : {}),
  };
}

/** Build a global-scope install manifest (no `projectId`). */
function mkGlobal(over: {
  name: string;
  agent: AgentKind;
  repoId: string;
  remote?: string;
  group?: string;
}): InstallManifest {
  return {
    skillId: { name: over.name, ...(over.group ? { group: over.group } : {}) },
    target: { agent: over.agent, scope: 'global' },
    destinationRoot: '/d',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [],
    hookEdits: [],
    sourceRepoId: over.repoId,
    ...(over.remote ? { sourceRemote: over.remote } : {}),
  };
}

describe('buildProjectPlan', () => {
  it('does not install a local (no .skid.yml identity) skill for a newly chosen agent, but does install an orphan that has one', () => {
    const installs = [
      // Local: installed from a working tree, no source remote -> remove-only.
      mk({ projectId: 'p1', name: 'loc', agent: 'claude', repoId: 'r-loc' }),
      // Orphan with .skid.yml identity (source remote) -> still installable.
      mk({ projectId: 'p1', name: 'orph', agent: 'claude', repoId: 'r-orph', remote: 'git@x:acme/o.git' }),
    ];
    const checked = [
      projectSkillKey('p1', 'r-loc', undefined, 'loc'),
      projectSkillKey('p1', 'r-orph', undefined, 'orph'),
    ];

    const plan = buildProjectPlan('p1', checked, installs, ['claude', 'codex']);

    const installRows = plan.rows.filter((r) => r.action === 'install');
    // Only the orphan is (re)installed -- for the newly added agent.
    expect(installRows.map((r) => r.ref.name)).toEqual(['orph']);
    expect(installRows[0]!.agents).toEqual(['codex']);
    // The local skill never appears as an install op for the new agent.
    const codex = plan.ops.find((o) => o.agent === 'codex');
    expect(codex?.install.map((r) => r.name)).toEqual(['orph']);
  });

  it('still removes a local skill when it is unchecked', () => {
    const installs = [mk({ projectId: 'p1', name: 'loc', agent: 'claude', repoId: 'r-loc' })];

    const plan = buildProjectPlan('p1', [], installs, ['claude']);

    expect(plan.rows.filter((r) => r.action === 'install')).toEqual([]);
    const removeRows = plan.rows.filter((r) => r.action === 'remove');
    expect(removeRows.map((r) => r.ref.name)).toEqual(['loc']);
  });

  it('leaves a still-checked local skill untouched (no install, no remove)', () => {
    const installs = [mk({ projectId: 'p1', name: 'loc', agent: 'claude', repoId: 'r-loc' })];
    const checked = [projectSkillKey('p1', 'r-loc', undefined, 'loc')];

    const plan = buildProjectPlan('p1', checked, installs, ['claude']);

    expect(plan.ops).toEqual([]);
  });

  it('installs a newly checked (not yet installed) skill for the chosen agent', () => {
    const plan = buildProjectPlan('p1', [projectSkillKey('p1', 'r1', undefined, 'fresh')], [], ['claude']);

    const installRows = plan.rows.filter((r) => r.action === 'install');
    expect(installRows.map((r) => r.ref.name)).toEqual(['fresh']);
    expect(installRows[0]!.agents).toEqual(['claude']);
  });

  // Regression: a global-scope manifest carries `scope: 'global'` and no
  // `projectId`, so matching on `target.scope === 'project'` (as this function
  // once did) silently dropped every already-installed global skill from the
  // plan -- it never showed as already present, and unchecking it never
  // produced a remove op.
  it('recognizes already-installed global-scope skills, matching by scope id', () => {
    const installs = [mkGlobal({ name: 'present', agent: 'claude', repoId: 'r-g' })];
    const checked = [projectSkillKey(GLOBAL_SCOPE_ID, 'r-g', undefined, 'present')];

    const plan = buildProjectPlan(GLOBAL_SCOPE_ID, checked, installs, ['claude']);

    // Already installed and still checked -> no ops at all.
    expect(plan.ops).toEqual([]);
  });

  it('removes a global-scope skill when it is unchecked', () => {
    const installs = [mkGlobal({ name: 'present', agent: 'claude', repoId: 'r-g' })];

    const plan = buildProjectPlan(GLOBAL_SCOPE_ID, [], installs, ['claude']);

    const removeRows = plan.rows.filter((r) => r.action === 'remove');
    expect(removeRows.map((r) => r.ref.name)).toEqual(['present']);
  });

  it('does not confuse a project-scope manifest for a global one with the same agent', () => {
    const installs = [mk({ projectId: 'p1', name: 'proj-only', agent: 'claude', repoId: 'r1' })];

    const plan = buildProjectPlan(GLOBAL_SCOPE_ID, [], installs, ['claude']);

    // The project-scope install must not leak into the global plan's removes.
    expect(plan.rows).toEqual([]);
  });
});
