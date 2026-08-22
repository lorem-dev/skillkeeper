/**
 * The Skills PAGES' selection arrangements, exercised over the pure functions.
 *
 * Scope, stated up front so this file is not over-trusted: it does not import
 * either page. React components are not unit tested here (renderer tests are
 * node-only and this project deliberately keeps them so), so a page rewired away
 * from the arrangement below will NOT fail this file. What it does is pin the
 * arrangement itself -- which key space the graph is built in, what goes into
 * `explicit` versus the baseline, and what each click does to both -- so that a
 * change in the meaning of `deriveSelection`, `applyCheckChange` or
 * `buildScopedGraph` fails here rather than only in the interface. That the
 * pages still call it this way rests on review, not on this test.
 *
 * The install modal's half of the feature is NOT here: it was extracted into
 * `features/skillInstall/lib/installSelection.ts`, which the modal really calls
 * and its own test really imports.
 */
import { describe, expect, it } from 'vitest';
import type { AgentKind, AvailableSkill, InstallManifest } from '@/services/bridge';
import { installedLeafIds, projectSkillKey, repoSkillKey } from './skillTree';
import { buildGraph, buildScopedGraph, brokenLeaves, contains, referenceKeys } from './requires';
import { applyCheckChange, deriveSelection, dropMissing, restore } from './selection';
import { buildProjectPlan } from './applyPlan';

const REPO = 'r1';
const PROJ = 'p1';
/** A project that was removed from the state while its installs stayed. */
const GONE = 'p2';

function parts(path: string): { group?: string; name: string } {
  const at = path.lastIndexOf('/');
  if (at < 0) return { name: path };
  return { group: path.slice(0, at), name: path.slice(at + 1) };
}
function rk(path: string): string {
  const { group, name } = parts(path);
  return repoSkillKey(REPO, group, name);
}
function pkIn(scopeId: string, path: string): string {
  const { group, name } = parts(path);
  return projectSkillKey(scopeId, REPO, group, name);
}
function pk(path: string): string {
  return pkIn(PROJ, path);
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
function instIn(
  scopeId: string,
  path: string,
  agents: readonly AgentKind[],
  requires?: string[],
): InstallManifest[] {
  const { group, name } = parts(path);
  return agents.map((agent) => ({
    skillId: { ...(group !== undefined ? { group } : {}), name },
    target: { agent, scope: 'project' as const, projectId: scopeId },
    destinationRoot: '/dest',
    sourceRepoId: REPO,
    sourceRemote: 'git@example.com:a/b.git',
    contentHash: 'h',
    installedAt: '2026-08-21T00:00:00.000Z',
    files: [],
    hookEdits: [],
    ...(requires !== undefined ? { requires } : {}),
  }));
}
function inst(path: string, agents: readonly AgentKind[], requires?: string[]): InstallManifest[] {
  return instIn(PROJ, path, agents, requires);
}

// a -> b -> c
const catalog = [mk('g/a', ['g/b']), mk('g/b', ['g/c']), mk('g/c')];

/** The Components page's derivation, exactly as the page composes it. */
function pageSelection(repoChecked: readonly string[]) {
  const graph = buildGraph(catalog, []);
  return { graph, sel: deriveSelection({ explicit: repoChecked, restored: [] }, [], graph) };
}

describe('skills page selection wiring', () => {
  it('page: checking a skill selects its transitive dependencies, tinted', () => {
    const { sel } = pageSelection([rk('g/a')]);
    expect(sel.shown).toEqual([rk('g/a'), rk('g/b'), rk('g/c')]);
    expect(sel.dependency).toEqual([rk('g/b'), rk('g/c')]);
  });

  it('page: unchecking the teal dependency clears the dependent too', () => {
    const { graph, sel } = pageSelection([rk('g/a')]);
    const next = sel.shown.filter((id) => id !== rk('g/b'));
    const after = applyCheckChange({ explicit: [rk('g/a')], restored: [] }, [], graph, sel.shown, next);
    expect(after.explicit).toEqual([]);
    expect(deriveSelection(after, [], graph).shown).toEqual([]);
  });

  it('page: unchecking the dependent drops its dependencies', () => {
    const { graph, sel } = pageSelection([rk('g/a')]);
    const next = sel.shown.filter((id) => id !== rk('g/a'));
    const after = applyCheckChange({ explicit: [rk('g/a')], restored: [] }, [], graph, sel.shown, next);
    expect(deriveSelection(after, [], graph).shown).toEqual([]);
  });

  it('management: broken leaf, and restore arms the missing closure', () => {
    // 'a' installed, requiring 'b', which is not installed anywhere.
    const installs = inst('g/a', ['claude'], ['g/b']);
    const broken = brokenLeaves({ scopeId: PROJ, available: catalog, installs });
    expect([...broken.keys()]).toEqual([pk('g/a')]);
    expect(broken.get(pk('g/a'))).toEqual(['g/b']);

    const graph = buildScopedGraph([PROJ], catalog, installs);
    const baseline = installedLeafIds(installs);
    expect(baseline).toEqual([pk('g/a')]);

    // Steady state: no repair asked for, so the closure is NOT armed.
    const before = deriveSelection({ explicit: baseline, restored: [] }, baseline, graph);
    expect(before.shown).toEqual([pk('g/a')]);
    expect(before.dependency).toEqual([]);

    // Clicking the broken badge.
    const repaired = restore({ explicit: baseline, restored: [] }, pk('g/a'));
    const after = deriveSelection(repaired, baseline, graph);
    expect(new Set(after.shown)).toEqual(new Set([pk('g/a'), pk('g/b'), pk('g/c')]));
    expect(new Set(after.dependency)).toEqual(new Set([pk('g/b'), pk('g/c')]));
    // Which is a real install, not just a tint.
    const plan = buildProjectPlan(PROJ, after.shown, installs, ['claude']);
    expect(plan.rows.filter((r) => r.action === 'install').map((r) => r.ref.name).sort()).toEqual(['b', 'c']);
  });

  it('management: unchecking a repaired leaf clears the pending repair', () => {
    const installs = inst('g/a', ['claude'], ['g/b']);
    const graph = buildScopedGraph([PROJ], catalog, installs);
    const baseline = installedLeafIds(installs);
    const repaired = restore({ explicit: baseline, restored: [] }, pk('g/a'));
    const shown = deriveSelection(repaired, baseline, graph).shown;
    const after = applyCheckChange(repaired, baseline, graph, shown, []);
    expect(after.restored).toEqual([]);
    expect(deriveSelection(after, baseline, graph).shown).toEqual([]);
  });

  it('management: reaches the installed-and-dependency-tinted state', () => {
    // The one arrangement where a leaf is installed, checked, AND tinted -- the
    // input to the badge chain's `present` arm, which must not be guarded on
    // `!isDependency` or this row ends up the only installed row with no badge.
    //
    // `y` is installed; `x` requires `y` and is NOT installed. Uncheck `y`, then
    // check `x`: `x` is not in the baseline so it seeds, and its closure re-adds
    // `y` -- which is still installed, and now held as somebody else's
    // dependency rather than as a pick of its own.
    const catalog2 = [mk('g/x', ['g/y']), mk('g/y')];
    const installs = inst('g/y', ['claude']);
    const graph = buildScopedGraph([PROJ], catalog2, installs);
    const baseline = installedLeafIds(installs);
    expect(baseline).toEqual([pk('g/y')]);

    // Uncheck the installed `y`: a plain pending removal, nothing tinted.
    const step1 = applyCheckChange({ explicit: baseline, restored: [] }, baseline, graph, baseline, []);
    expect(deriveSelection(step1, baseline, graph).shown).toEqual([]);

    // Now check `x`.
    const step2 = applyCheckChange(step1, baseline, graph, [], [pk('g/x')]);
    const d = deriveSelection(step2, baseline, graph);
    expect(new Set(d.shown)).toEqual(new Set([pk('g/x'), pk('g/y')]));
    expect(d.dependency).toEqual([pk('g/y')]);
    // installed AND checked AND tinted, all at once.
    expect(baseline).toContain(pk('g/y'));
  });

  it('management: unchecking an installed dependency keeps the installed dependent', () => {
    const installs = [...inst('g/a', ['claude'], ['g/b']), ...inst('g/b', ['claude'], ['g/c']), ...inst('g/c', ['claude'])];
    const graph = buildScopedGraph([PROJ], catalog, installs);
    const baseline = installedLeafIds(installs);
    const shown = deriveSelection({ explicit: baseline, restored: [] }, baseline, graph).shown;
    const next = shown.filter((id) => id !== pk('g/b'));
    const after = applyCheckChange({ explicit: baseline, restored: [] }, baseline, graph, shown, next);
    // 'a' is installed, so it survives the uncheck -- and because the baseline
    // is excluded from the seeds, it does NOT re-arm 'b'. So 'b' really is a
    // pending removal that will break 'a', with no click-time warning: the
    // orange marker after apply is the designed feedback.
    const d = deriveSelection(after, baseline, graph);
    expect(new Set(after.explicit)).toEqual(new Set([pk('g/a'), pk('g/c')]));
    expect(new Set(d.shown)).toEqual(new Set([pk('g/a'), pk('g/c')]));
    expect(d.dependency).toEqual([]);

    // And after that apply, 'a' is the broken leaf the marker is drawn on.
    const applied = [...inst('g/a', ['claude'], ['g/b']), ...inst('g/c', ['claude'])];
    const broken = brokenLeaves({ scopeId: PROJ, available: catalog, installs: applied });
    expect([...broken.keys()]).toEqual([pk('g/a')]);
    expect(broken.get(pk('g/a'))).toEqual(['g/b']);
  });

  it('management: a dependency installed for fewer agents is repairable', () => {
    // The spec's own case: `a` is installed for claude AND codex and requires
    // `b`; `b` is installed for claude only. `a` is broken at codex, and the
    // repair is an install of `b` for codex -- a diff that exists only at
    // (skill, agent) granularity, which the apply plan resolves.
    const catalog2 = [mk('g/a', ['g/b']), mk('g/b')];
    const installs = [...inst('g/a', ['claude', 'codex'], ['g/b']), ...inst('g/b', ['claude'])];
    const broken = brokenLeaves({ scopeId: PROJ, available: catalog2, installs });
    expect([...broken.keys()]).toEqual([pk('g/a')]);
    const missing = broken.get(pk('g/a')) ?? [];
    expect(missing).toEqual(['g/b']);

    const graph = buildScopedGraph([PROJ], catalog2, installs);
    const baseline = installedLeafIds(installs, [PROJ]);
    // Repairability, as the page asks it: does a MISSING reference name a skill
    // that exists? Asking instead whether the leaf's closure holds something not
    // in the leaf-level installed set answers NO here -- `b` IS installed, just
    // not for every agent `a` has -- which is what marked this case broken and
    // unrepairable at once, badge without a click and tooltip inviting one.
    const keys = referenceKeys(pk('g/a'), missing);
    expect(keys.some((k) => contains(graph, k))).toBe(true);
    expect(keys.every((k) => baseline.includes(k))).toBe(true);

    // And the repair really is one: the plan installs `b` for the agent it is
    // missing at, and touches nothing else.
    const shown = dropMissing(
      graph,
      deriveSelection({ explicit: baseline, restored: [pk('g/a')] }, baseline, graph),
    ).shown;
    const plan = buildProjectPlan(PROJ, shown, installs, ['claude', 'codex']);
    expect(plan.rows.map((r) => ({ name: r.ref.name, action: r.action, agents: r.agents }))).toEqual(
      [{ name: 'b', action: 'install', agents: ['codex'] }],
    );
  });

  it('management: a dependency that exists nowhere is not repairable', () => {
    // The arm that keeps a badge non-interactive: the reference names a skill no
    // repository and no ledger entry knows, so there is nothing to install and
    // the tooltip must not promise a click.
    const catalog2 = [mk('g/a', ['g/ghost'])];
    const installs = inst('g/a', ['claude'], ['g/ghost']);
    const graph = buildScopedGraph([PROJ], catalog2, installs);
    const missing = brokenLeaves({ scopeId: PROJ, available: catalog2, installs }).get(pk('g/a'));
    expect(missing).toEqual(['g/ghost']);
    expect(referenceKeys(pk('g/a'), missing ?? []).some((k) => contains(graph, k))).toBe(false);
  });

  it('management: an install outside the shown scopes is no pending removal', () => {
    // `projects::remove` drops the project record and KEEPS its installs, and
    // `reconcile` preserves them deliberately. So the ledger can hold an install
    // whose scope is not among the ones the page shows -- while the graph spans
    // only those scopes. A baseline drawn from the whole ledger then counts that
    // install as a pending removal forever: nothing is drawn for it, and Save
    // cannot clear it, because the save path iterates the tracked scopes only.
    // The baseline and the graph must therefore span the same set of scopes.
    const scopeIds = [PROJ];
    const installs = [...instIn(PROJ, 'g/c', ['claude']), ...instIn(GONE, 'g/c', ['claude'])];
    const graph = buildScopedGraph(scopeIds, catalog, installs);
    const baseline = installedLeafIds(installs, scopeIds);

    // The page's derivation, verbatim: hand picks seeded from the baseline.
    const shown = dropMissing(
      graph,
      deriveSelection({ explicit: baseline, restored: [] }, baseline, graph),
    ).shown;
    const shownSet = new Set(shown);
    // `pendingRemove` is exactly this difference.
    expect(baseline.filter((id) => !shownSet.has(id))).toEqual([]);
    // The whole ledger still holds both installs; only the baseline is scoped.
    expect(installedLeafIds(installs)).toHaveLength(2);
    expect(baseline).toEqual([pkIn(PROJ, 'g/c')]);
  });
});
