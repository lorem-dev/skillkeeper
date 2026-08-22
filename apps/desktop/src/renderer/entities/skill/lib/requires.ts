/**
 * The skill dependency graph, renderer side.
 *
 * A skill declares the other skills of its own repository that it needs
 * (`skillkeeper.requires`). This module answers the three questions the Skills
 * pages ask: what does checking this skill pull in ({@link closure}), what
 * breaks if this one goes away ({@link dependents}), and which installed skills
 * are missing a dependency ({@link brokenLeaves}).
 *
 * Nodes are keyed by the same checkbox ids the tree uses, so a caller never
 * converts between a graph node and a tree node. Dependencies never cross
 * repositories, so a reference is resolved within the referrer's own repo id.
 *
 * This mirrors `crates/skillkeeper-core/src/skills/requires.rs`. The core is
 * authoritative at apply time; this copy exists so the tree can be drawn without
 * a bridge round trip per click. Both are covered by the same case table, and
 * the traversal orders below are deliberately identical to the Rust ones -- see
 * the note on {@link closure}.
 */
import type { AgentKind, AvailableSkill, InstallManifest } from '@/services/bridge';
import { scopeIdOf } from '@/domain';
import {
  parseProjectSkillKey,
  parseRepoSkillKey,
  parseSkillKeyTail,
  projectSkillKey,
  repoSkillKey,
} from './skillTree';

/** A skill's reference form: `group/name`, or `name` when ungrouped. */
export function skillPath(group: string | undefined, name: string): string {
  return group === undefined || group === '' ? name : `${group}/${name}`;
}

/** Split a reference back into the group/name pair a checkbox key needs. */
function splitPath(path: string): { group?: string; name: string } {
  const at = path.lastIndexOf('/');
  if (at < 0) return { name: path };
  return { group: path.slice(0, at), name: path.slice(at + 1) };
}

/** The repo-mode key for a reference inside `repoId`. */
function keyOf(repoId: string, path: string): string {
  const { group, name } = splitPath(path);
  return repoSkillKey(repoId, group, name);
}

/**
 * Render a checkbox key back as the reference form an author would recognize, so
 * a tooltip or a message shows `group/name` rather than an internal key.
 *
 * Arity-tolerant via {@link parseSkillKeyTail}, so it is correct for a
 * project-mode key as well as a repo-mode one. That matters: a fixed three-field
 * parse drops the name of a scoped key, which would collapse every leaf of one
 * (scope, repo, group) onto the same path and leave {@link dependents} sorting a
 * scoped graph in an arbitrary order.
 */
function keyToPath(key: string): string {
  const { group, name } = parseSkillKeyTail(key);
  return skillPath(group, name);
}

/**
 * Compare two strings by Unicode code point, which is exactly UTF-8 byte order
 * -- the order the Rust mirror's `BTreeSet` and `Vec::sort` produce.
 *
 * JavaScript's default sort compares UTF-16 code units instead, and the two
 * disagree whenever a supplementary-plane character (U+10000 and up, stored as
 * a surrogate pair starting at 0xD800) meets one in U+E000..U+FFFF.
 */
function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = left[i]?.codePointAt(0) ?? 0;
    const y = right[i]?.codePointAt(0) ?? 0;
    if (x !== y) return x - y;
  }
  return left.length - right.length;
}

/**
 * Sort repo-mode keys the way the Rust mirror sorts the paths they encode.
 *
 * The Rust graph is keyed by `group/name`; this one is keyed by a
 * percent-encoded `repoId::group::name`. Sorting the keys is NOT the same
 * ordering: `/` is 0x2F and the `::` separator starts at 0x3A, so `a/b` sorts
 * before `a1/c` as paths and after it as keys. Ordering is therefore computed in
 * the path domain, with the key as a tiebreak so that the same path in two
 * repositories -- or two scopes -- still has a total order.
 *
 * Works for the project-mode keys of a {@link buildScopedGraph} graph too, since
 * {@link keyToPath} reads the path out of a key of either arity.
 */
function sortByPath(keys: Iterable<string>): string[] {
  return [...keys]
    .map((key) => [keyToPath(key), key] as const)
    .sort((x, y) => {
      const byPath = byCodePoint(x[0], y[0]);
      return byPath !== 0 ? byPath : byCodePoint(x[1], y[1]);
    })
    .map(([, key]) => key);
}

/** Rebuild a repo-mode key as the project-mode leaf id for `scopeId`. */
function projectKeyOf(scopeId: string, key: string): string {
  const { repoId, group, name } = parseRepoSkillKey(key);
  return projectSkillKey(scopeId, repoId, group, name);
}

/**
 * The key the adjacency hangs off. Module-private and never exported, which is
 * what makes {@link RequiresGraph} genuinely opaque rather than merely
 * documented as such: there is no name a consumer could use to reach the maps.
 */
const DATA: unique symbol = Symbol('skillkeeper.requiresGraph');

/**
 * Adjacency over repo-mode keys, plus the reverse.
 *
 * A key present in `forward` is a skill we know about; a key that only ever
 * appears as a value is a missing reference. Neither map is sorted -- the
 * traversals sort their own output where the Rust mirror does.
 */
interface GraphData {
  readonly forward: ReadonlyMap<string, readonly string[]>;
  readonly reverse: ReadonlyMap<string, readonly string[]>;
}

/**
 * A built dependency graph. Opaque: pass it to the functions below, which are
 * THE contract for reading it.
 *
 * The Rust mirror keeps its adjacency private behind `contains` and
 * `requires_of`, and this does the same. A caller reading the maps directly --
 * or hand-rolling `forward.has(...)` in place of {@link contains} -- reimplements
 * a traversal rule next to the one that is kept in step with the core, which is
 * how this copy drifts. Build it once per catalog and memoize; every query is a
 * plain traversal.
 */
export interface RequiresGraph {
  readonly [DATA]: GraphData;
}

/**
 * Whether `key` is a node of this graph -- a skill we know about -- as opposed
 * to a reference to something absent.
 *
 * The mirror of the Rust `RequiresGraph::contains`, and the supported way to ask
 * the question. Cheaper and safer than inspecting the graph yourself.
 */
export function contains(graph: RequiresGraph, key: string): boolean {
  return graph[DATA].forward.has(key);
}

/**
 * The dependencies `key` declares, as repo-mode keys, in the author's order.
 *
 * The mirror of the Rust `RequiresGraph::requires_of`. Empty both when the skill
 * declares no dependencies and when `key` is not a skill at all -- use
 * {@link contains} to tell those apart.
 */
export function requiresOf(graph: RequiresGraph, key: string): readonly string[] {
  return graph[DATA].forward.get(key) ?? [];
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** One node and the repo-mode keys it depends on. */
type Edge = readonly [string, readonly string[]];

/** Resolve a node's references to repo-mode keys inside its own repository. */
function keysOf(repoId: string, refs: readonly string[]): string[] {
  return refs.map((ref) => keyOf(repoId, ref));
}

/**
 * Build from raw `(node, dependency keys)` pairs -- the mirror of the Rust
 * `RequiresGraph::build_from_edges`, and the one place the adjacency is
 * assembled.
 *
 * A repeated node merges rather than replaces, so a caller drawing on several
 * sources cannot silently lose an edge. A node with no dependencies still
 * becomes a key, which is what lets {@link contains} tell "declares nothing"
 * apart from "is not a skill".
 */
function buildFromEdges(edges: Iterable<Edge>): RequiresGraph {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const [from, to] of edges) {
    if (!forward.has(from)) forward.set(from, []);
    for (const target of to) {
      push(forward, from, target);
      push(reverse, target, from);
    }
  }
  return { [DATA]: { forward, reverse } };
}

/**
 * Build from the catalog, unioned with the edges recorded in install manifests.
 * A repeated node merges rather than replaces, so no source silently loses an
 * edge; a node with no dependencies still becomes a key, which is what tells
 * "declares nothing" apart from "is not a skill".
 *
 * The ledger edges are what make an orphan work: a skill whose repository is
 * gone is absent from the catalog, so without its recorded `requires` its
 * broken state could never be detected.
 */
export function buildGraph(
  skills: readonly AvailableSkill[],
  installs: readonly InstallManifest[],
): RequiresGraph {
  const edges: Edge[] = [];
  for (const s of skills) {
    edges.push([repoSkillKey(s.repoId, s.group, s.name), keysOf(s.repoId, s.requires ?? [])]);
  }
  for (const m of installs) {
    const repoId = m.sourceRepoId;
    if (repoId === undefined) continue;
    edges.push([
      repoSkillKey(repoId, m.skillId.group, m.skillId.name),
      keysOf(repoId, m.requires ?? []),
    ]);
  }
  return buildFromEdges(edges);
}

/**
 * The same graph as {@link buildGraph}, but keyed by PROJECT-MODE leaf ids --
 * one copy of the catalog per scope in `scopeIds`.
 *
 * {@link buildGraph}'s nodes are repo-mode keys, which is exactly what the
 * repositories-mode tree checks. The Management page and the install modal check
 * boxes whose ids carry a scope, so driving the selection model there from a
 * repo-mode graph would resolve nothing at all -- silently, since a key that is
 * not a node simply has no dependencies.
 *
 * Replicated per scope rather than translated per query, because that is what
 * makes the scopes independent: a dependency is only ever satisfied inside its
 * own scope, so one project's copy of a skill and another's are different nodes,
 * and unchecking a dependency in one project cannot disturb the other. Edges
 * never leave their scope by construction.
 *
 * Ledger edges are added for the manifests of those same scopes, so an orphan --
 * installed, repository gone, hence absent from the catalog -- still carries the
 * dependencies it was installed with. Manifests outside `scopeIds` are skipped:
 * their nodes are not in the tree, and admitting them would put another scope's
 * ids in a closure.
 */
export function buildScopedGraph(
  scopeIds: readonly string[],
  skills: readonly AvailableSkill[],
  installs: readonly InstallManifest[],
): RequiresGraph {
  const scopes = [...new Set(scopeIds)];
  const edges: Edge[] = [];
  for (const scopeId of scopes) {
    for (const s of skills) {
      edges.push([
        projectSkillKey(scopeId, s.repoId, s.group, s.name),
        keysOf(s.repoId, s.requires ?? []).map((key) => projectKeyOf(scopeId, key)),
      ]);
    }
  }
  const wanted = new Set(scopes);
  for (const m of installs) {
    const repoId = m.sourceRepoId;
    if (repoId === undefined) continue;
    // A project-scoped target with no project id belongs to no scope at all, so
    // there is no node to hang its edges off.
    const scopeId = scopeIdOf(m.target);
    if (scopeId === undefined || !wanted.has(scopeId)) continue;
    edges.push([
      projectSkillKey(scopeId, repoId, m.skillId.group, m.skillId.name),
      keysOf(repoId, m.requires ?? []).map((key) => projectKeyOf(scopeId, key)),
    ]);
  }
  return buildFromEdges(edges);
}

/**
 * Transitive closure of `roots`, roots included, each root's subtree walked
 * breadth first and fully drained before the next root starts.
 *
 * The per-root drain is not an implementation detail: a shared `seen` set means
 * a node reachable from two roots is listed exactly once, but the roots are
 * never interleaved, so `closure([a, x])` is `closure([a])` followed by the
 * still-unseen part of `closure([x])`. Callers rely on that when they report
 * installs root by root. Root order therefore matters whenever two roots'
 * subtrees overlap -- `closure([a, x])` and `closure([x, a])` may list shared
 * nodes at different positions. Each order is individually deterministic; the
 * two are not interchangeable. Do NOT "simplify" this into one shared queue:
 * that interleaves the roots and silently diverges from the Rust mirror.
 *
 * A missing target is kept: the caller wants to know it was reached, and
 * dropping it here would make a broken dependency indistinguishable from an
 * absent one. Cycle-safe -- a visited node is never queued twice.
 */
export function closure(graph: RequiresGraph, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
    const queue: string[] = [root];
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
      for (const target of requiresOf(graph, current)) {
        if (seen.has(target)) continue;
        seen.add(target);
        queue.push(target);
        out.push(target);
      }
    }
  }
  return out;
}

/**
 * Everything that depends on any of `targets`, directly or transitively. The
 * targets themselves are NOT included -- the question this answers is "what else
 * breaks", and including the cause would make every call site filter it back
 * out.
 *
 * Sorted rather than traversal-ordered, matching the Rust mirror: this list is a
 * report, and a report reads better alphabetically than by discovery order. The
 * sort runs in the path domain -- see {@link sortByPath}, which is what makes
 * this ordering identical to the Rust one rather than merely deterministic.
 * Cycle-safe.
 */
export function dependents(graph: RequiresGraph, targets: readonly string[]): string[] {
  const seen = new Set<string>(targets);
  const queue: string[] = [...new Set(targets)];
  const out = new Set<string>();
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const dependent of graph[DATA].reverse.get(current) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
      out.add(dependent);
    }
  }
  return sortByPath(out);
}

/** The inputs {@link brokenLeaves} needs: one scope, the catalog, the ledger. */
export interface BrokenArgs {
  /** Project id, or the reserved global scope id. */
  readonly scopeId: string;
  /** The whole catalog; only the edges of `scopeId`'s installs are consulted. */
  readonly available: readonly AvailableSkill[];
  /** Every install manifest, across scopes. Filtered to `scopeId` internally. */
  readonly installs: readonly InstallManifest[];
}

/**
 * One installed skill at one target: its node key and the dependency keys that
 * install was promised.
 */
interface TargetInstall {
  readonly key: string;
  readonly deps: readonly string[];
}

/**
 * The installs of one scope at one agent, as graph edges.
 *
 * An install's edges are its OWN recorded `requires` when it has them, falling
 * back to what the catalog declares for that skill when it does not. Per-install
 * rather than unioned across a skill's installs: two installs of the same skill
 * can have been promised different dependencies, and crediting one with the
 * other's edges invents a requirement. The catalog fallback covers a manifest
 * written before `requires` was recorded, while the ledger-first order is what
 * keeps an orphan working -- it has ledger edges and no catalog entry at all.
 *
 * The CLI's counterpart, `report_broken_dependents` in
 * `crates/skillkeeper-cli/src/commands/skill.rs`, deliberately has NO catalog
 * fallback: it uses the ledger only. Both are right for their own question. It
 * answers "what did this command break", so an edge nobody was ever promised
 * cannot have been broken by it. This answers "what is broken now", where a
 * manifest recording no `requires` is missing information rather than asserting
 * that there are none, and today's catalog is the best account of it available.
 * Change one and read the other.
 */
function installsAtTarget(
  inScope: readonly InstallManifest[],
  agent: AgentKind,
  catalogRequires: ReadonlyMap<string, readonly string[]>,
): TargetInstall[] {
  const out: TargetInstall[] = [];
  for (const m of inScope) {
    if (m.target.agent !== agent) continue;
    const repoId = m.sourceRepoId;
    if (repoId === undefined) continue;
    const key = repoSkillKey(repoId, m.skillId.group, m.skillId.name);
    out.push({ key, deps: keysOf(repoId, m.requires ?? catalogRequires.get(key) ?? []) });
  }
  return out;
}

/**
 * Installed leaves in this scope whose dependency closure is not fully
 * satisfied, mapped to the references that are missing.
 *
 * Satisfaction is judged per (skill, target), the way the CLI's
 * `report_broken_dependents` judges it: a skill only works for the agent it was
 * installed for, so a dependency is satisfied for an install only when the
 * dependency is installed at that install's OWN target. Each target therefore
 * gets its own graph, in which being a node is exactly "installed here" -- so
 * the unsatisfied members of a closure are the ones the graph does not
 * {@link contains}.
 *
 * Evaluating per target rather than per skill matters: a skill installed for two
 * agents can have been promised different dependencies at each. Unioning its
 * edges while intersecting its agents -- demanding every edge at every agent --
 * reports breakage that does not exist, and paints a marker on a working skill.
 *
 * A LEAF is broken when ANY of its targets is broken, because the tree shows
 * leaves and not per-agent rows. The references it reports are the union across
 * its broken targets, deduplicated and sorted by path.
 *
 * Broken state is transitive in both directions, and falls out of reachability
 * rather than a special case: with `a -> b -> c` and `c` absent, `b`'s closure
 * reaches `c` and so does `a`'s, so both are reported.
 *
 * Keys are project-mode leaf ids for `scopeId`, ready to index the tree; values
 * are reference forms (`group/name`), ready to show.
 */
export function brokenLeaves(args: BrokenArgs): Map<string, string[]> {
  const { scopeId, available, installs } = args;
  // Matched through `scopeIdOf` rather than on `target.scope`: a global install
  // carries no project id, and matching on the scope alone would drop every
  // global-scope manifest.
  const inScope = installs.filter((m) => scopeIdOf(m.target) === scopeId);

  // What the catalog declares today, for an install that recorded nothing.
  const catalogRequires = new Map<string, readonly string[]>();
  for (const s of available) {
    if (s.requires === undefined) continue;
    catalogRequires.set(repoSkillKey(s.repoId, s.group, s.name), s.requires);
  }

  // A scope pins the scope/project fields of a target, so within one scope a
  // target is exactly its agent.
  const agents: AgentKind[] = [];
  for (const m of inScope) {
    if (!agents.includes(m.target.agent)) agents.push(m.target.agent);
  }

  const missingByLeaf = new Map<string, Set<string>>();
  for (const agent of agents) {
    const atTarget = installsAtTarget(inScope, agent, catalogRequires);
    const graph = buildFromEdges(atTarget.map((i) => [i.key, i.deps] as const));
    for (const { key } of atTarget) {
      // The root is a node of its own target's graph, so `contains` excludes it
      // without a special case -- exactly as in the CLI.
      const unsatisfied = closure(graph, [key]).filter((dep) => !contains(graph, dep));
      if (unsatisfied.length === 0) continue;
      const leaf = projectKeyOf(scopeId, key);
      const seen = missingByLeaf.get(leaf) ?? new Set<string>();
      for (const dep of unsatisfied) seen.add(keyToPath(dep));
      missingByLeaf.set(leaf, seen);
    }
  }

  const out = new Map<string, string[]>();
  for (const [leaf, refs] of missingByLeaf) {
    out.set(leaf, [...refs].sort(byCodePoint));
  }
  return out;
}

/**
 * The graph keys for `refs`, read as references of `leaf` -- the inverse of the
 * reference forms {@link brokenLeaves} reports as its values.
 *
 * A reference never leaves its referrer's repository, and never leaves the scope
 * the referrer is installed in, so a reference resolves in `leaf`'s own scope
 * and repo id. Provided rather than left to the caller because rebuilding a key
 * by hand is exactly the kind of near-copy of {@link buildScopedGraph}'s keying
 * that drifts: ask {@link contains} about these keys, not about ids you assembled
 * yourself.
 */
export function referenceKeys(leaf: string, refs: readonly string[]): string[] {
  const { projectId, repoId } = parseProjectSkillKey(leaf);
  return refs.map((ref) => {
    const { group, name } = splitPath(ref);
    return projectSkillKey(projectId, repoId, group, name);
  });
}
