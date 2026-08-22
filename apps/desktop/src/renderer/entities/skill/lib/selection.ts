/**
 * The Skills pages' selection model.
 *
 * The store holds only what the user picked BY HAND (`explicit`) plus the
 * installed skills whose dependency closure they asked to re-apply
 * (`restored`). Everything else is derived:
 *
 *     seeds      = (explicit \ baseline) union restored
 *     shown      = explicit union closure(seeds)
 *     dependency = shown \ explicit \ baseline
 *
 * Nothing records WHY a checkbox is on, so no sequence of clicks can
 * desynchronize it -- which is the whole point. The alternative, a checked set
 * plus an "auto-added" set mutated per click, needs reference counting and
 * drifts.
 *
 * `baseline` (the installed set for the scope, empty in repositories mode) is
 * deliberately excluded from the seeds: without that, opening a project whose
 * installed skill has a missing dependency would immediately queue an install
 * nobody asked for, and the broken state -- the thing the user needs to see --
 * could not exist. {@link restore} is how the user opts into repairing it.
 *
 * `baseline` is excluded from `dependency` too, for a different reason: an
 * installed leaf can re-enter `shown` through the closure without ever
 * re-joining `explicit` -- it was dropped from `explicit` when its own
 * dependent got unchecked, and {@link restore} seeds the closure, not the
 * pick. Teal means "will be newly installed because something else needs
 * it"; a leaf that is merely being RETAINED is neither new nor an install, so
 * it must not read that way. Simplifying this back to `shown \ explicit` is
 * exactly the edit that reintroduces that false teal on every already-
 * installed dependency a repair brings back.
 *
 * One consequence worth stating, because it looks like a gap until you try it: a
 * dependency cannot be promoted to an explicit pick by clicking it. Its box is
 * already checked, so a click is an UNCHECK, and unchecking a dependency clears
 * its dependents with it. The only way a dependency becomes explicit is to check
 * it before -- or instead of -- the skill that needs it, which
 * {@link deriveSelection} then honours by leaving it out of `dependency`.
 */
import { closure, contains, dependents } from './requires';
import type { RequiresGraph } from './requires';

/** What the store keeps. Everything else about the selection is derived. */
export interface Selection {
  /** Leaf ids the user checked by hand (in project mode, seeded with what is installed). */
  readonly explicit: readonly string[];
  /** Installed leaf ids whose dependency closure the user asked to re-apply. */
  readonly restored: readonly string[];
}

/** What the tree needs to draw. */
export interface DerivedSelection {
  /** Every checked leaf id. */
  readonly shown: string[];
  /** Of those, the ones selected because something else needs them. */
  readonly dependency: string[];
}

/**
 * Expand a stored {@link Selection} into the checked set and the subset of it
 * that is only checked because something else needs it.
 *
 * The whole derivation, and the only place it lives. `shown` keeps the explicit
 * picks first, in the order they were made, followed by whatever the closure
 * adds; `dependency` is a filter of that same list, so the two agree by
 * construction rather than by being maintained together.
 */
export function deriveSelection(
  sel: Selection,
  baseline: readonly string[],
  graph: RequiresGraph,
): DerivedSelection {
  const explicit = new Set(sel.explicit);
  const installed = new Set(baseline);
  // Every member of `restored` is an installed leaf the user asked to repair, so
  // it belongs in the seeds unconditionally; `closure` deduplicates the overlap
  // with the explicit picks.
  const seeds = [...sel.explicit.filter((id) => !installed.has(id)), ...sel.restored];
  const shown = new Set(sel.explicit);
  for (const id of closure(graph, [...new Set(seeds)])) shown.add(id);
  const shownList = [...shown];
  // `dependency` excludes `installed` as well as `explicit`: an installed leaf
  // can re-enter `shown` via `restore`'s closure without ever re-joining
  // `explicit` (see the file header), and teal must mean "will be newly
  // installed", not "will be retained". Dropping the `installed` half of this
  // filter is the natural-looking simplification that brings the false teal
  // back -- read the header before making that edit.
  return {
    shown: shownList,
    dependency: shownList.filter((id) => !explicit.has(id) && !installed.has(id)),
  };
}

/**
 * Drop the ids that are not skills at all from a derived selection.
 *
 * {@link closure} deliberately keeps a reference it could not resolve, so that a
 * caller can tell "this dependency is missing" from "this dependency was never
 * mentioned". That is right for a report and wrong for a checkbox set: a
 * reference naming a skill that exists in no repository and no ledger entry is
 * not a row in any tree, and passing it on means counting a pending install that
 * cannot happen and building an apply plan with a row that must fail.
 *
 * So every surface that turns a selection into something the user acts on files
 * it through here first. `dependency` is filtered with the same predicate rather
 * than recomputed, so the two lists stay in step by construction.
 *
 * This is a filter, not a repair: the leaf that named the missing reference is
 * still broken, and still says so.
 */
export function dropMissing(graph: RequiresGraph, derived: DerivedSelection): DerivedSelection {
  const real = (id: string): boolean => contains(graph, id);
  return { shown: derived.shown.filter(real), dependency: derived.dependency.filter(real) };
}

/**
 * Toggle one leaf.
 *
 * Checking is trivial: add to `explicit`. Unchecking is where the two symmetric
 * rules live -- drop the leaf itself, and drop everything whose closure reaches
 * it, so unchecking a dependency also unchecks its dependents. Installed skills
 * (in `baseline`) are never dropped as collateral: only an explicit click on
 * one removes it, and that is a planned removal, not a side effect.
 */
export function toggle(
  sel: Selection,
  baseline: readonly string[],
  graph: RequiresGraph,
  id: string,
): Selection {
  const derived = deriveSelection(sel, baseline, graph);
  if (!derived.shown.includes(id)) {
    return { explicit: [...sel.explicit, id], restored: sel.restored };
  }
  const installed = new Set(baseline);
  // Everything that (transitively) needs `id`, plus `id` itself.
  const doomed = new Set([id, ...dependents(graph, [id])]);
  return {
    // An installed skill survives unless it IS the one clicked: unchecking a
    // dependency must never queue an uninstall of something that already works.
    explicit: sel.explicit.filter((k) => !doomed.has(k) || (installed.has(k) && k !== id)),
    restored: sel.restored.filter((k) => !doomed.has(k)),
  };
}

/**
 * Force `id` on as a hand pick, idempotently. Unlike {@link toggle} this never
 * removes: a checkbox the tree reports as newly ON must end up ON, whether it
 * was off or was already showing as somebody else's dependency.
 */
function check(sel: Selection, id: string): Selection {
  if (sel.explicit.includes(id)) return sel;
  return { explicit: [...sel.explicit, id], restored: sel.restored };
}

/**
 * Fold a whole checkbox change from the tree into the selection.
 *
 * The tree hands back the full next set of checked leaf ids rather than the one
 * that changed, and a branch checkbox flips many leaves at once, so the reducer
 * has to diff: the symmetric difference of `shown` and `next` is the set of ids
 * the user actually acted on. The two directions are then handled differently,
 * and deliberately so.
 *
 * An ADDITION always becomes an explicit pick. Ticking a branch is the user
 * covering every box under it by hand, so a dependency that happens to live in
 * that branch is not an auto selection and must not be drawn or described as
 * one -- that would be the interface stating something untrue about what the
 * user did. It also means the dependency survives its dependent being unchecked
 * later, which is right: it was picked, not inferred.
 *
 * A REMOVAL is skipped when the id is already off, because within one change the
 * ids alias each other. Unchecking a branch holding both a dependent and its
 * dependency reports both as changed, but dropping the dependent already drops
 * the dependency -- so toggling it blindly would find its box off and turn it
 * back ON, promoting a dependency to a hand pick by way of an UNCHECK. Skipping
 * it makes the fold converge on `next` and stay idempotent, whatever order the
 * tree reports ids in.
 *
 * Removals are folded before additions, and that order is load-bearing rather
 * than tidy: with `b` picked and `c` its dependency, replacing the selection
 * with `a` must land on `a`. Additions first would add `a`, and then unchecking
 * `b` would take `a` down with it as a dependent of `b`'s subtree -- wiping the
 * pick the user just made.
 */
export function applyCheckChange(
  sel: Selection,
  baseline: readonly string[],
  graph: RequiresGraph,
  shown: readonly string[],
  next: readonly string[],
): Selection {
  const before = new Set(shown);
  const after = new Set(next);
  let acc = sel;
  for (const id of shown) {
    if (after.has(id)) continue;
    // Already gone as collateral of an earlier removal: leave it alone.
    if (!deriveSelection(acc, baseline, graph).shown.includes(id)) continue;
    acc = toggle(acc, baseline, graph, id);
  }
  for (const id of next) {
    if (before.has(id)) continue;
    acc = check(acc, id);
  }
  return acc;
}

/** Ask for `id`'s dependency closure to be re-applied (the broken-badge click). */
export function restore(sel: Selection, id: string): Selection {
  if (sel.restored.includes(id)) return sel;
  return { explicit: sel.explicit, restored: [...sel.restored, id] };
}
