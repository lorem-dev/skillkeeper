import { describe, expect, it } from 'vitest';
import type { AgentKind, AvailableSkill, InstallManifest } from '@/services/bridge';
import { GLOBAL_SCOPE_ID } from '@/domain';
import { projectSkillKey, repoSkillKey } from './skillTree';
import {
  brokenLeaves,
  buildGraph,
  closure,
  contains,
  dependents,
  requiresOf,
  skillPath,
} from './requires';

/** The single repository every fixture skill belongs to: a dependency never
 *  crosses repositories, so one repo is the whole domain. */
const REPO = 'r1';

/** Split a `group/name` reference the way the fixtures declare them. */
function parts(path: string): { group?: string; name: string } {
  const at = path.lastIndexOf('/');
  if (at < 0) return { name: path };
  return { group: path.slice(0, at), name: path.slice(at + 1) };
}

/** The repo-mode checkbox key a fixture path maps to. Built by calling the tree
 *  helper rather than spelling the key out, so the key format stays one place. */
function rk(path: string): string {
  const { group, name } = parts(path);
  return repoSkillKey(REPO, group, name);
}

/** The project-mode leaf id a fixture path maps to inside `scopeId`. */
function pk(scopeId: string, path: string): string {
  const { group, name } = parts(path);
  return projectSkillKey(scopeId, REPO, group, name);
}

/** A catalog skill with the given path and dependencies. */
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

/** One install manifest of `path` per agent, in `scopeId`. `GLOBAL_SCOPE_ID`
 *  produces global-scope targets, which carry no project id at all. */
function inst(
  scopeId: string,
  path: string,
  agents: readonly AgentKind[],
  requires?: string[],
): InstallManifest[] {
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
    ...(requires !== undefined ? { requires } : {}),
  }));
}

const chain = [mk('a', ['b']), mk('b', ['c']), mk('c')];
const diamond = [mk('a', ['b', 'c']), mk('b', ['d']), mk('c', ['d']), mk('d')];

describe('skillPath', () => {
  it('renders an ungrouped and a grouped identity', () => {
    expect(skillPath(undefined, 's')).toBe('s');
    expect(skillPath('g', 's')).toBe('g/s');
    expect(skillPath('g/h/i', 's')).toBe('g/h/i/s');
  });

  it('treats an empty group as no group', () => {
    expect(skillPath('', 's')).toBe('s');
  });
});

describe('contains and requiresOf', () => {
  it('tells a skill apart from a reference to something absent', () => {
    const g = buildGraph([mk('a', ['ghost'])], []);
    expect(contains(g, rk('a'))).toBe(true);
    expect(contains(g, rk('ghost'))).toBe(false);
  });

  it('reports the declared list in the author order', () => {
    const g = buildGraph([mk('a', ['c', 'b']), mk('b'), mk('c')], []);
    expect(requiresOf(g, rk('a'))).toEqual([rk('c'), rk('b')]);
  });

  it('is empty both for a skill declaring nothing and for a non-skill', () => {
    const g = buildGraph([mk('a', [])], []);
    expect(requiresOf(g, rk('a'))).toEqual([]);
    expect(requiresOf(g, rk('ghost'))).toEqual([]);
    // Only `contains` tells those two apart.
    expect(contains(g, rk('a'))).toBe(true);
    expect(contains(g, rk('ghost'))).toBe(false);
  });

  it('keeps the adjacency out of the exported shape', () => {
    // The graph publishes no readable property: the adjacency hangs off a
    // module-private symbol, so a consumer has the accessors and nothing else.
    expect(Object.keys(buildGraph([mk('a')], []))).toEqual([]);
  });
});

describe('closure', () => {
  it('includes every hop of a chain and the root', () => {
    expect(closure(buildGraph(chain, []), [rk('a')])).toEqual([rk('a'), rk('b'), rk('c')]);
  });

  it('is just the leaf for a leaf', () => {
    expect(closure(buildGraph(chain, []), [rk('c')])).toEqual([rk('c')]);
  });

  it('lists a diamond dependency once, breadth first', () => {
    const g = buildGraph(diamond, []);
    expect(closure(g, [rk('a')])).toEqual([rk('a'), rk('b'), rk('c'), rk('d')]);
  });

  it('is the union for several disjoint roots, in root order', () => {
    const g = buildGraph([mk('a', ['b']), mk('b'), mk('x', ['y']), mk('y')], []);
    expect(closure(g, [rk('a'), rk('x')])).toEqual([rk('a'), rk('b'), rk('x'), rk('y')]);
  });

  it('follows root order for disjoint roots too', () => {
    // Disjoint subtrees share nothing, so nothing forces an order except the
    // roots slice -- and each root is still drained before the next starts,
    // rather than the two being interleaved.
    const g = buildGraph([mk('a', ['b']), mk('b'), mk('x', ['y']), mk('y')], []);
    expect(closure(g, [rk('x'), rk('a')])).toEqual([rk('x'), rk('y'), rk('a'), rk('b')]);
  });

  it('merges the catalog and ledger edges of one node rather than replacing', () => {
    // The catalog says `a` needs `b`; the ledger recorded that it needed `c`.
    // Neither source wins: a node seen twice unions its edges, so both hops are
    // reachable. Whichever replaced the other would hide a real dependency.
    const g = buildGraph([mk('a', ['b'])], inst('p1', 'a', ['claude'], ['c']));
    expect(requiresOf(g, rk('a'))).toEqual([rk('b'), rk('c')]);
    expect(closure(g, [rk('a')])).toEqual([rk('a'), rk('b'), rk('c')]);
  });

  it('follows root order for overlapping roots rather than a sorted union', () => {
    // `b` is reachable from `a`, so when both are roots whichever root is
    // processed first claims the shared subtree. This is the mirror-divergence
    // hazard: a naive single-queue multi-root BFS (or a sorted union of
    // independent closures) answers the same regardless of root order, and
    // `crates/skillkeeper-core/src/skills/requires.rs` does not. Asserted
    // unsorted, on purpose -- sorting here would prove nothing.
    const g = buildGraph(chain, []);
    expect(closure(g, [rk('a'), rk('b')])).toEqual([rk('a'), rk('b'), rk('c')]);
    expect(closure(g, [rk('b'), rk('a')])).toEqual([rk('b'), rk('c'), rk('a')]);
  });

  it('lists a node reachable from two roots exactly once', () => {
    const g = buildGraph([mk('a', ['shared']), mk('x', ['shared']), mk('shared')], []);
    expect(closure(g, [rk('a'), rk('x')])).toEqual([rk('a'), rk('shared'), rk('x')]);
  });

  it('ignores a repeated root', () => {
    expect(closure(buildGraph(chain, []), [rk('a'), rk('a')])).toEqual([rk('a'), rk('b'), rk('c')]);
  });

  it('terminates on a two-cycle', () => {
    const g = buildGraph([mk('a', ['b']), mk('b', ['a'])], []);
    expect(closure(g, [rk('a')])).toEqual([rk('a'), rk('b')]);
  });

  it('terminates on a three-cycle', () => {
    const g = buildGraph([mk('a', ['b']), mk('b', ['c']), mk('c', ['a'])], []);
    expect(closure(g, [rk('a')])).toEqual([rk('a'), rk('b'), rk('c')]);
  });

  it('keeps a missing target so the caller can report it', () => {
    const g = buildGraph([mk('a', ['ghost'])], []);
    expect(closure(g, [rk('a')])).toEqual([rk('a'), rk('ghost')]);
  });

  it('keeps a dangling middle hop', () => {
    const g = buildGraph([mk('a', ['b']), mk('b', ['ghost'])], []);
    expect(closure(g, [rk('a')])).toEqual([rk('a'), rk('b'), rk('ghost')]);
  });

  it('returns an unknown root unchanged', () => {
    expect(closure(buildGraph(chain, []), [rk('nope')])).toEqual([rk('nope')]);
  });

  it('is deterministic across two builds of the same catalog', () => {
    const g = buildGraph(diamond, []);
    expect(closure(buildGraph(diamond, []), [rk('a')])).toEqual(closure(g, [rk('a')]));
  });

  it('treats an empty declaration as no dependencies', () => {
    expect(closure(buildGraph([mk('a', [])], []), [rk('a')])).toEqual([rk('a')]);
  });

  it('treats a missing declaration as no dependencies', () => {
    expect(closure(buildGraph([mk('a')], []), [rk('a')])).toEqual([rk('a')]);
  });

  it('resolves a grouped reference within the referrer repository', () => {
    const g = buildGraph([mk('g/a', ['g/b']), mk('g/b')], []);
    expect(closure(g, [rk('g/a')])).toEqual([rk('g/a'), rk('g/b')]);
  });

  it('keeps two repositories apart', () => {
    const other: AvailableSkill = { ...mk('b'), repoId: 'r2', repoName: 'r2' };
    const g = buildGraph([mk('a', ['b']), other], []);
    // `a` in r1 reaches r1's `b`, which is absent -- not r2's `b`.
    expect(closure(g, [rk('a')])).toEqual([rk('a'), rk('b')]);
    expect(closure(g, [repoSkillKey('r2', undefined, 'b')])).toEqual([
      repoSkillKey('r2', undefined, 'b'),
    ]);
  });

  it('unions the catalog with the edges recorded in install manifests', () => {
    // The catalog knows nothing about `a`; only the ledger does.
    const g = buildGraph([], inst('p1', 'a', ['claude'], ['b']));
    expect(closure(g, [rk('a')])).toEqual([rk('a'), rk('b')]);
  });

  it('is empty input safe', () => {
    expect(closure(buildGraph([], []), [])).toEqual([]);
  });
});

describe('dependents', () => {
  it('walks backwards and excludes the target', () => {
    expect(dependents(buildGraph(chain, []), [rk('c')])).toEqual([rk('a'), rk('b')].sort());
    expect(dependents(buildGraph(diamond, []), [rk('d')])).toEqual(
      [rk('a'), rk('b'), rk('c')].sort(),
    );
  });

  it('sorts in the path domain, not the encoded-key domain', () => {
    // The regression the encoded-key sort produced. Rust compares the paths
    // `a/b` and `a1/c`: `/` is 0x2F, below `1`, so `a/b` comes first. The keys
    // encode that slash as `%2F` and join fields with `::`, whose first byte is
    // 0x3A, above `1` -- so sorting the keys reverses the pair. Asserted in the
    // exact Rust order, unsorted, because `.sort()` here is the bug.
    const g = buildGraph([mk('a/b', ['t']), mk('a1/c', ['t']), mk('t')], []);
    expect(dependents(g, [rk('t')])).toEqual([rk('a/b'), rk('a1/c')]);
    // And the encoded keys really do disagree, so the test above has teeth.
    expect([rk('a/b'), rk('a1/c')].sort()).toEqual([rk('a1/c'), rk('a/b')]);
  });

  it('sorts by code point, the order UTF-8 bytes give', () => {
    // U+F000 is a single UTF-16 code unit; U+10000 is the surrogate pair
    // 0xD800 0xDC00. A default sort compares code units and puts the pair
    // first; UTF-8 byte order -- which is what the Rust mirror uses -- puts
    // U+F000 first, because 0xF000 < 0x10000.
    const low = '\uF000';
    const high = '\u{10000}';
    const g = buildGraph([mk(low, ['t']), mk(high, ['t']), mk('t')], []);
    expect(dependents(g, [rk('t')])).toEqual([rk(low), rk(high)]);
    // And a default sort of those same paths really does disagree, so the
    // assertion above has teeth. (Percent-encoding happens to be byte-ordered,
    // so this only bites once the key is decoded back into a path -- which is
    // exactly what sorting in the path domain does.)
    expect([low, high].sort()).toEqual([high, low]);
  });

  it('is sorted, not traversal ordered', () => {
    // Reverse traversal from `c` discovers `b` then `a`; the Rust mirror sorts
    // because this list is a report. Keep the two spellings identical.
    const sorted = [rk('a'), rk('b')].sort();
    expect(dependents(buildGraph(chain, []), [rk('c')])).toEqual(sorted);
  });

  it('is empty for a root', () => {
    expect(dependents(buildGraph(chain, []), [rk('a')])).toEqual([]);
  });

  it('is empty for an unknown target', () => {
    expect(dependents(buildGraph(chain, []), [rk('nope')])).toEqual([]);
  });

  it('terminates on a two-cycle', () => {
    const g = buildGraph([mk('a', ['b']), mk('b', ['a'])], []);
    expect(dependents(g, [rk('a')])).toEqual([rk('b')]);
  });

  it('terminates on a three-cycle', () => {
    const g = buildGraph([mk('a', ['b']), mk('b', ['c']), mk('c', ['a'])], []);
    expect(dependents(g, [rk('a')])).toEqual([rk('b'), rk('c')].sort());
  });

  it('unions several targets and excludes all of them', () => {
    const g = buildGraph(diamond, []);
    expect(dependents(g, [rk('b'), rk('c')])).toEqual([rk('a')]);
  });
});

describe('brokenLeaves', () => {
  it('marks a skill whose dependency is not installed in the scope', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b')],
      installs: inst('p1', 'a', ['claude'], ['b']),
    });
    expect([...broken.keys()]).toEqual([pk('p1', 'a')]);
    expect(broken.get(pk('p1', 'a'))).toEqual(['b']);
  });

  it('marks nothing when the dependency is installed for the same agents', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b')],
      installs: [...inst('p1', 'a', ['claude'], ['b']), ...inst('p1', 'b', ['claude'])],
    });
    expect(broken.size).toBe(0);
  });

  it('marks a dependency installed for fewer agents than its dependent', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b')],
      installs: [...inst('p1', 'a', ['claude', 'codex'], ['b']), ...inst('p1', 'b', ['claude'])],
    });
    expect([...broken.keys()]).toEqual([pk('p1', 'a')]);
    expect(broken.get(pk('p1', 'a'))).toEqual(['b']);
  });

  it('marks nothing when the dependency is installed for a strict superset', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b')],
      installs: [...inst('p1', 'a', ['claude'], ['b']), ...inst('p1', 'b', ['claude', 'codex'])],
    });
    expect(broken.size).toBe(0);
  });

  it('ignores an install of the dependency in another scope', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b')],
      installs: [...inst('p1', 'a', ['claude'], ['b']), ...inst('p2', 'b', ['claude'])],
    });
    expect([...broken.keys()]).toEqual([pk('p1', 'a')]);
  });

  it('marks a dependent transitively when a middle hop is satisfied but the last is not', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b', ['c']), mk('c')],
      installs: [...inst('p1', 'a', ['claude'], ['b']), ...inst('p1', 'b', ['claude'], ['c'])],
    });
    expect([...broken.keys()].sort()).toEqual([pk('p1', 'a'), pk('p1', 'b')].sort());
    expect(broken.get(pk('p1', 'a'))).toEqual(['c']);
    expect(broken.get(pk('p1', 'b'))).toEqual(['c']);
  });

  it('uses the ledger edges for an orphan whose repository is gone', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [],
      installs: inst('p1', 'a', ['claude'], ['b']),
    });
    expect([...broken.keys()]).toEqual([pk('p1', 'a')]);
    expect(broken.get(pk('p1', 'a'))).toEqual(['b']);
  });

  it('marks nothing when neither the install nor the catalog declares one', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a')],
      installs: inst('p1', 'a', ['claude']),
    });
    expect(broken.size).toBe(0);
  });

  it('covers global-scope installs, which carry no project id', () => {
    const broken = brokenLeaves({
      scopeId: GLOBAL_SCOPE_ID,
      available: [mk('a', ['b']), mk('b')],
      installs: inst(GLOBAL_SCOPE_ID, 'a', ['claude'], ['b']),
    });
    expect([...broken.keys()]).toEqual([pk(GLOBAL_SCOPE_ID, 'a')]);
    expect(broken.get(pk(GLOBAL_SCOPE_ID, 'a'))).toEqual(['b']);
  });

  it('reports a missing dependency by its reference form, not its key', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('g/a', ['g/h/b'])],
      installs: inst('p1', 'g/a', ['claude'], ['g/h/b']),
    });
    expect(broken.get(pk('p1', 'g/a'))).toEqual(['g/h/b']);
  });

  it('lists every missing dependency of one dependent', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b', 'c'])],
      installs: inst('p1', 'a', ['claude'], ['b', 'c']),
    });
    expect(broken.get(pk('p1', 'a'))).toEqual(['b', 'c']);
  });

  it('does not mark a skill whose other target was promised nothing', () => {
    // `a@claude` needs `b` and `b@claude` exists; `a@codex` recorded no
    // dependencies at all, so it needs nothing. NOTHING here is broken.
    // Unioning `a`'s edges across its installs while intersecting its agents --
    // demanding `b` at codex too -- is the false positive this guards against.
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b')],
      installs: [
        ...inst('p1', 'a', ['claude'], ['b']),
        ...inst('p1', 'a', ['codex'], []),
        ...inst('p1', 'b', ['claude']),
      ],
    });
    expect(broken.size).toBe(0);
  });

  it('does not credit a dependency installed at a different target', () => {
    // Same scope, different agent: `b@codex` is invisible to `a@claude`, so
    // this is a genuine same-target failure and must still be reported.
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b')],
      installs: [...inst('p1', 'a', ['claude'], ['b']), ...inst('p1', 'b', ['codex'])],
    });
    expect([...broken.keys()]).toEqual([pk('p1', 'a')]);
    expect(broken.get(pk('p1', 'a'))).toEqual(['b']);
  });

  it('unions the missing references across a leaf broken targets', () => {
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [],
      installs: [...inst('p1', 'a', ['codex'], ['c', 'b']), ...inst('p1', 'a', ['claude'], ['b'])],
    });
    expect([...broken.keys()]).toEqual([pk('p1', 'a')]);
    // `b` is missing at both targets and is listed once; the union is sorted by
    // path, so the codex target's declaration order does not leak out.
    expect(broken.get(pk('p1', 'a'))).toEqual(['b', 'c']);
  });

  it("prefers an install's recorded dependencies over the catalog", () => {
    // The catalog says `a` needs nothing today; the install was promised `b`.
    // What the install was promised is what decides whether it works.
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', [])],
      installs: inst('p1', 'a', ['claude'], ['b']),
    });
    expect(broken.get(pk('p1', 'a'))).toEqual(['b']);
  });

  it('falls back to the catalog for an install that recorded nothing', () => {
    // A manifest written before `requires` was recorded: the catalog is the
    // only edge source, and it says `a` needs `b`, which is not installed.
    const broken = brokenLeaves({
      scopeId: 'p1',
      available: [mk('a', ['b']), mk('b')],
      installs: inst('p1', 'a', ['claude']),
    });
    expect(broken.get(pk('p1', 'a'))).toEqual(['b']);
  });

  it('is empty input safe', () => {
    expect(brokenLeaves({ scopeId: 'p1', available: [], installs: [] }).size).toBe(0);
  });
});
