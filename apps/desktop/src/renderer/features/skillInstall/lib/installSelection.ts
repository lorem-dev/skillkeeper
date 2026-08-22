/**
 * The install modal's selection arithmetic, extracted whole.
 *
 * It lives here rather than inline in the modal for one reason: the step that
 * matters most in this flow -- building the apply plan from the DERIVED checked
 * set rather than from the user's hand picks -- cannot be tested inside a React
 * component under this project's node-only renderer test rule. Extracted, it is
 * ordinary pure code, and {@link resolveInstallSelection} owns that step so no
 * caller is in a position to get it wrong.
 *
 * The flow is: the Components page hands over its hand picks (repo-mode keys,
 * WITHOUT their dependencies, because the page stores only what was clicked);
 * {@link seedInstallSelection} rebases them onto the chosen scope and unions in
 * what is already installed there; {@link resolveInstallSelection} then expands
 * that into the checked set and the plan. The closure has to be recomputed per
 * scope rather than carried over from the page, because whether a dependency is
 * an install at all depends on the scope: one already installed there is not.
 */
import type { AgentKind, AvailableSkill, InstallManifest } from '@/services/bridge';
import {
  buildProjectPlan,
  buildScopedGraph,
  deriveSelection,
  dropMissing,
  installedLeafIds,
  parseProjectSkillKey,
  parseRepoSkillKey,
  projectSkillKey,
} from '@/entities/skill';
import type { DerivedSelection, ProjectPlan, RequiresGraph, Selection } from '@/entities/skill';

/**
 * The project-mode leaf ids installed in `scopeId`, which are both the modal's
 * pre-checked rows and the selection's baseline.
 */
export function installedInScope(
  scopeId: string,
  installs: readonly InstallManifest[],
): string[] {
  return installedLeafIds(installs).filter((k) => parseProjectSkillKey(k).projectId === scopeId);
}

/**
 * Rebase the page's repo-mode hand picks onto `scopeId` and seed a selection
 * with them plus everything already installed there.
 *
 * The picks go into `explicit`, NOT into a checked set: that is precisely what
 * makes {@link deriveSelection} treat them as requests and pull their
 * dependencies in. The installed ids go into `explicit` too so their rows stay
 * checked, but they are also the baseline, so they seed no closure of their own
 * and an installed skill with a missing dependency is left alone rather than
 * silently queued for repair.
 */
export function seedInstallSelection(
  scopeId: string,
  skillKeys: readonly string[],
  installs: readonly InstallManifest[],
): Selection {
  const rebased = skillKeys.map((key) => {
    const r = parseRepoSkillKey(key);
    return projectSkillKey(scopeId, r.repoId, r.group, r.name);
  });
  return {
    explicit: [...new Set([...installedInScope(scopeId, installs), ...rebased])],
    restored: [],
  };
}

/**
 * The scope-dependent half of the arithmetic: the dependency graph and the
 * baseline.
 *
 * Split from {@link resolveInstallSelection} because it is the expensive part and
 * it does NOT depend on the selection: `buildScopedGraph` walks the whole catalog
 * once per scope, and rebuilding that on every checkbox click -- or every change
 * of the chosen agents, which it has nothing to do with -- is real work per
 * keystroke on a large catalog. The caller memoizes this on the catalog, the
 * ledger and the scope, and the cheap half on the selection.
 */
export interface InstallScope {
  /** Project id, or the reserved global scope id. */
  readonly scopeId: string;
  /**
   * Keyed by project-mode leaf id for this one scope, matching the tree's
   * checkboxes; a repo-mode graph would resolve none of them and every
   * dependency would be dropped in silence.
   */
  readonly graph: RequiresGraph;
  /** What is already installed here: the selection's baseline. */
  readonly baseline: string[];
}

/**
 * Build the graph and baseline for one scope.
 *
 * The graph unions the catalog with the ledger, so an install whose repository
 * is gone still contributes the edges it was made with.
 */
export function buildInstallScope(
  scopeId: string,
  available: readonly AvailableSkill[],
  installs: readonly InstallManifest[],
): InstallScope {
  return {
    scopeId,
    graph: buildScopedGraph([scopeId], available, installs),
    baseline: installedInScope(scopeId, installs),
  };
}

/** What the modal draws and what it applies -- from one derivation. */
export interface InstallSelectionView {
  /** What the tree draws: the checked leaves, and which of them are dependencies. */
  readonly derived: DerivedSelection;
  /**
   * What Save applies. Built from `derived.shown`, never from `selection`'s hand
   * picks -- building it from the picks is the one mistake that would draw every
   * dependency correctly and then install none of them.
   */
  readonly plan: ProjectPlan;
}

/** The inputs {@link resolveInstallSelection} needs. */
export interface InstallSelectionArgs {
  /** The scope's graph and baseline, from {@link buildInstallScope}. */
  readonly scope: InstallScope;
  /** The modal's own hand picks and repairs. */
  readonly selection: Selection;
  /** Every install manifest, across scopes; the plan filters to the scope. */
  readonly installs: readonly InstallManifest[];
  /** The agents chosen in step 1. */
  readonly agents: readonly AgentKind[];
}

/**
 * Expand a stored selection into what the modal draws and what it applies.
 *
 * Derives ONCE and feeds both from that one value, so the drawn state and the
 * applied state cannot disagree -- which is the whole reason this is one
 * function and not two. Unresolvable references are filtered out of the result:
 * a dependency naming a skill that exists nowhere is no row in this tree and no
 * install anybody can perform, so it must not reach the checked set, the counts,
 * or the plan.
 */
export function resolveInstallSelection(args: InstallSelectionArgs): InstallSelectionView {
  const { scope, selection, installs, agents } = args;
  const derived = dropMissing(scope.graph, deriveSelection(selection, scope.baseline, scope.graph));
  return { derived, plan: buildProjectPlan(scope.scopeId, derived.shown, installs, agents) };
}
