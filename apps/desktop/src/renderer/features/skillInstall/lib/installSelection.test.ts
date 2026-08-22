import { describe, expect, it } from 'vitest';
import type { AgentKind, AvailableSkill, InstallManifest } from '@/services/bridge';
import { GLOBAL_SCOPE_ID } from '@/domain';
import { buildProjectPlan, deriveSelection, projectSkillKey, repoSkillKey } from '@/entities/skill';
import {
  buildInstallScope,
  installedInScope,
  resolveInstallSelection,
  seedInstallSelection,
} from './installSelection';

const REPO = 'r1';
const PROJ = 'p1';

function parts(path: string): { group?: string; name: string } {
  const at = path.lastIndexOf('/');
  if (at < 0) return { name: path };
  return { group: path.slice(0, at), name: path.slice(at + 1) };
}
/** The repo-mode key the Components page would hand over for `path`. */
function rk(path: string): string {
  const { group, name } = parts(path);
  return repoSkillKey(REPO, group, name);
}
/** The project-mode leaf id `path` has inside `scopeId`. */
function pk(scopeId: string, path: string): string {
  const { group, name } = parts(path);
  return projectSkillKey(scopeId, REPO, group, name);
}
function mk(path: string, requires?: string[]): AvailableSkill {
  const { group, name } = parts(path);
  return {
    repoId: REPO,
    repoName: REPO,
    remote: 'git@example.com:a/b.git',
    ...(group !== undefined ? { group } : {}),
    name,
    contentHash: 'h',
    hasGuidance: false,
    ...(requires !== undefined ? { requires } : {}),
  };
}
function inst(scopeId: string, path: string, agents: readonly AgentKind[]): InstallManifest[] {
  const { group, name } = parts(path);
  return agents.map((agent) => ({
    skillId: { ...(group !== undefined ? { group } : {}), name },
    target:
      scopeId === GLOBAL_SCOPE_ID
        ? { agent, scope: 'global' as const }
        : { agent, scope: 'project' as const, projectId: scopeId },
    destinationRoot: '/dest',
    sourceRepoId: REPO,
    sourceRemote: 'git@example.com:a/b.git',
    contentHash: 'h',
    installedAt: '2026-08-21T00:00:00.000Z',
    files: [],
    hookEdits: [],
  }));
}

/** g/a -> g/b -> g/c. */
const catalog = [mk('g/a', ['g/b']), mk('g/b', ['g/c']), mk('g/c')];
const CLAUDE: AgentKind[] = ['claude'];

describe('installedInScope', () => {
  it('keeps only the leaves of the asked-for scope', () => {
    const installs = [...inst(PROJ, 'g/a', CLAUDE), ...inst('p2', 'g/b', CLAUDE)];
    expect(installedInScope(PROJ, installs)).toEqual([pk(PROJ, 'g/a')]);
  });

  it('resolves a global install into the global scope', () => {
    expect(installedInScope(GLOBAL_SCOPE_ID, inst(GLOBAL_SCOPE_ID, 'g/a', CLAUDE))).toEqual([
      pk(GLOBAL_SCOPE_ID, 'g/a'),
    ]);
  });
});

describe('seedInstallSelection', () => {
  it('rebases the page keys onto the scope and unions in what is installed', () => {
    const sel = seedInstallSelection(PROJ, [rk('g/a')], inst(PROJ, 'g/c', CLAUDE));
    expect(new Set(sel.explicit)).toEqual(new Set([pk(PROJ, 'g/c'), pk(PROJ, 'g/a')]));
    expect(sel.restored).toEqual([]);
  });

  it('does not expand the closure itself -- that is the derivation step', () => {
    const sel = seedInstallSelection(PROJ, [rk('g/a')], []);
    expect(sel.explicit).toEqual([pk(PROJ, 'g/a')]);
  });
});

describe('buildInstallScope', () => {
  it('carries the scope, its baseline, and a graph keyed for that scope', () => {
    const installs = inst(PROJ, 'g/c', CLAUDE);
    const scope = buildInstallScope(PROJ, catalog, installs);
    expect(scope.scopeId).toBe(PROJ);
    expect(scope.baseline).toEqual([pk(PROJ, 'g/c')]);
    // Keyed by project-mode leaf id: a repo-mode key resolves to nothing, which
    // is the silent failure this scoping exists to prevent.
    expect(deriveSelection({ explicit: [pk(PROJ, 'g/a')], restored: [] }, [], scope.graph).shown)
      .toEqual([pk(PROJ, 'g/a'), pk(PROJ, 'g/b'), pk(PROJ, 'g/c')]);
    expect(deriveSelection({ explicit: [rk('g/a')], restored: [] }, [], scope.graph).shown).toEqual([
      rk('g/a'),
    ]);
  });

  it('does not depend on the selection or the chosen agents', () => {
    // The whole point of the split: this is memoized on the catalog, the ledger
    // and the scope, so a checkbox click cannot rebuild the catalog walk.
    expect(buildInstallScope.length).toBe(3);
  });
});

describe('resolveInstallSelection', () => {
  /** The page's hand picks, as the modal receives them. */
  const HAND_PICKS = [rk('g/a')];

  it('installs the whole closure of the keys the page handed over', () => {
    // The page stores hand picks only, so what arrives here is ONE key even
    // though the page drew three checked boxes.
    expect(HAND_PICKS).toHaveLength(1);
    const selection = seedInstallSelection(PROJ, HAND_PICKS, []);
    expect(selection.explicit).toHaveLength(1);

    const view = resolveInstallSelection({
      scope: buildInstallScope(PROJ, catalog, []),
      selection,
      installs: [],
      agents: CLAUDE,
    });

    // Drawn: all three checked, the two dependencies tinted.
    expect(new Set(view.derived.shown)).toEqual(
      new Set([pk(PROJ, 'g/a'), pk(PROJ, 'g/b'), pk(PROJ, 'g/c')]),
    );
    expect(new Set(view.derived.dependency)).toEqual(new Set([pk(PROJ, 'g/b'), pk(PROJ, 'g/c')]));

    // Applied: all three. This is the assertion the whole feature turns on --
    // the plan comes from the derived set, not from the hand picks.
    expect(view.plan.rows.map((r) => r.ref.name).sort()).toEqual(['a', 'b', 'c']);
    expect(view.plan.ops[0]?.install.map((r) => r.name).sort()).toEqual(['a', 'b', 'c']);

    // For contrast, the mistake this guards against: a plan built from the hand
    // picks draws the same three boxes and installs one skill.
    expect(buildProjectPlan(PROJ, selection.explicit, [], CLAUDE).rows.map((r) => r.ref.name)).toEqual([
      'a',
    ]);
  });

  it('does not re-install a dependency already present in this scope', () => {
    const installs = inst(PROJ, 'g/c', CLAUDE);
    const view = resolveInstallSelection({
      scope: buildInstallScope(PROJ, catalog, installs),
      selection: seedInstallSelection(PROJ, HAND_PICKS, installs),
      installs,
      agents: CLAUDE,
    });
    expect(new Set(view.derived.shown)).toEqual(
      new Set([pk(PROJ, 'g/a'), pk(PROJ, 'g/b'), pk(PROJ, 'g/c')]),
    );
    // 'c' is installed, so it is a baseline row, not a dependency-tinted add.
    expect(view.derived.dependency).toEqual([pk(PROJ, 'g/b')]);
    expect(
      view.plan.rows.filter((r) => r.action === 'install').map((r) => r.ref.name).sort(),
    ).toEqual(['a', 'b']);
  });

  it('leaves another scope installs out of the baseline and the plan', () => {
    const installs = inst('p2', 'g/c', CLAUDE);
    const scope = buildInstallScope(PROJ, catalog, installs);
    const view = resolveInstallSelection({
      scope,
      selection: seedInstallSelection(PROJ, HAND_PICKS, installs),
      installs,
      agents: CLAUDE,
    });
    expect(scope.baseline).toEqual([]);
    // p2's copy of 'c' satisfies nothing here: it is still an install for p1.
    expect(
      view.plan.rows.filter((r) => r.action === 'install').map((r) => r.ref.name).sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it('works in the global scope', () => {
    const view = resolveInstallSelection({
      scope: buildInstallScope(GLOBAL_SCOPE_ID, catalog, []),
      selection: seedInstallSelection(GLOBAL_SCOPE_ID, HAND_PICKS, []),
      installs: [],
      agents: CLAUDE,
    });
    expect(new Set(view.derived.shown)).toEqual(
      new Set([
        pk(GLOBAL_SCOPE_ID, 'g/a'),
        pk(GLOBAL_SCOPE_ID, 'g/b'),
        pk(GLOBAL_SCOPE_ID, 'g/c'),
      ]),
    );
    expect(view.plan.rows.map((r) => r.ref.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('plans nothing from an empty selection', () => {
    const view = resolveInstallSelection({
      scope: buildInstallScope(PROJ, catalog, []),
      selection: { explicit: [], restored: [] },
      installs: [],
      agents: CLAUDE,
    });
    expect(view.derived.shown).toEqual([]);
    expect(view.plan.ops).toEqual([]);
  });
});

describe('resolveInstallSelection with an unresolvable dependency', () => {
  // `g/a` names `g/nope`, which no repository and no ledger entry knows.
  const orphaned = [mk('g/a', ['g/nope'])];

  it('never plans an install for a skill that exists nowhere', () => {
    const view = resolveInstallSelection({
      scope: buildInstallScope(PROJ, orphaned, []),
      selection: seedInstallSelection(PROJ, [rk('g/a')], []),
      installs: [],
      agents: CLAUDE,
    });
    expect(view.derived.shown).toEqual([pk(PROJ, 'g/a')]);
    expect(view.derived.dependency).toEqual([]);
    expect(view.plan.rows.map((r) => r.ref.name)).toEqual(['a']);
  });
});
