import { describe, expect, it } from 'vitest';
import type { AvailableSkill } from '@/services/bridge';
import { repoSkillKey } from './skillTree';
import { buildGraph } from './requires';
import { applyCheckChange, dropMissing, deriveSelection, restore, toggle } from './selection';

/** The single repository every fixture skill belongs to. */
const REPO = 'r1';

/** A catalog skill at `path` (`group/name` or `name`) with its dependencies. */
function mk(path: string, requires?: string[]): AvailableSkill {
  const at = path.lastIndexOf('/');
  const group = at < 0 ? undefined : path.slice(0, at);
  const name = at < 0 ? path : path.slice(at + 1);
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

/**
 * a -> b -> c, plus an independent d, plus e -> b (a diamond onto b), plus three
 * groups for the branch folds `applyCheckChange` performs:
 *
 * - `g`: three independent leaves.
 * - `p`: a dependent and its dependency, and NOTHING below the dependency --
 *   a two-node chain, so that dropping the dependent leaves the dependency with
 *   no dependents of its own to drop it a second time. That is what makes the
 *   removal direction of the convergence guard observable; on the three-node
 *   `a -> b -> c` chain the unguarded fold re-adds `b` and then removes it again
 *   as collateral of `c`, landing on the right answer by coincidence.
 * - `h`: a branch whose leaf `h/u` is needed by the installed leaf `w`, so
 *   unchecking the branch actually consults the installed-dependent guard.
 */
const CATALOG = [
  mk('a', ['b']),
  mk('b', ['c']),
  mk('c'),
  mk('d'),
  mk('e', ['b']),
  mk('g/x'),
  mk('g/y'),
  mk('g/z'),
  mk('p/dependent', ['p/dependency']),
  mk('p/dependency'),
  mk('w', ['h/u']),
  mk('h/u'),
  mk('h/v'),
];
const G = buildGraph(CATALOG, []);

/** The checkbox key a fixture path maps to, built by the tree helper so the key
 *  format stays in one place. */
const K = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at < 0
    ? repoSkillKey(REPO, undefined, path)
    : repoSkillKey(REPO, path.slice(0, at), path.slice(at + 1));
};

const sel = (
  explicit: string[],
  restored: string[] = [],
): { explicit: string[]; restored: string[] } => ({
  explicit,
  restored,
});

describe('deriveSelection', () => {
  it('pulls in the transitive closure of an explicit pick', () => {
    const d = deriveSelection(sel([K('a')]), [], G);
    expect(d.shown.sort()).toEqual([K('a'), K('b'), K('c')].sort());
    expect(d.dependency.sort()).toEqual([K('b'), K('c')].sort());
  });

  it('leaves an explicitly picked dependency out of the dependency set', () => {
    // Reachable by checking `b` first and `a` second: `b` is then a hand pick
    // that also happens to be needed by `a`.
    const d = deriveSelection(sel([K('b'), K('a')]), [], G);
    expect(d.dependency).toEqual([K('c')]);
  });

  it('does not seed the closure from the installed baseline', () => {
    // `a` is installed and requires `b`, which is not. Opening the page must
    // NOT queue `b` for install -- that is the broken state, shown as `!`.
    const d = deriveSelection(sel([K('a')]), [K('a')], G);
    expect(d.shown).toEqual([K('a')]);
    expect(d.dependency).toEqual([]);
  });

  it('seeds the closure from a restored installed skill', () => {
    const d = deriveSelection(sel([K('a')], [K('a')]), [K('a')], G);
    expect(d.shown.sort()).toEqual([K('a'), K('b'), K('c')].sort());
    expect(d.dependency.sort()).toEqual([K('b'), K('c')].sort());
  });

  it('is empty for an empty selection', () => {
    expect(deriveSelection(sel([]), [], G)).toEqual({ shown: [], dependency: [] });
  });
});

describe('toggle', () => {
  it('checking a skill adds it to the explicit set', () => {
    expect(toggle(sel([]), [], G, K('a')).explicit).toEqual([K('a')]);
  });

  it('unchecking an explicit skill drops its dependencies with it', () => {
    const after = toggle(sel([K('a')]), [], G, K('a'));
    expect(after.explicit).toEqual([]);
    expect(deriveSelection(after, [], G).shown).toEqual([]);
  });

  it('unchecking a dependency drops the dependent too', () => {
    // The rule from the request: unchecking `b` must also uncheck `a`.
    const after = toggle(sel([K('a')]), [], G, K('b'));
    expect(after.explicit).toEqual([]);
    expect(deriveSelection(after, [], G).shown).toEqual([]);
  });

  it('unchecking a shared dependency drops every dependent of it', () => {
    const after = toggle(sel([K('a'), K('e')]), [], G, K('b'));
    expect(after.explicit).toEqual([]);
  });

  it('unchecking a dependency leaves an unrelated pick alone', () => {
    const after = toggle(sel([K('a'), K('d')]), [], G, K('b'));
    expect(after.explicit).toEqual([K('d')]);
  });

  it('never removes an installed skill from the explicit set', () => {
    // `a` is installed; unchecking `c` must not silently uninstall `a`.
    const after = toggle(sel([K('a'), K('c')]), [K('a')], G, K('c'));
    expect(after.explicit).toEqual([K('a')]);
  });

  it('unchecking an installed skill removes it, which is a planned removal', () => {
    const after = toggle(sel([K('a')]), [K('a')], G, K('a'));
    expect(after.explicit).toEqual([]);
  });

  it('unchecking a restored dependency clears the restore', () => {
    const after = toggle(sel([K('a')], [K('a')]), [K('a')], G, K('b'));
    expect(after.restored).toEqual([]);
    expect(after.explicit).toEqual([K('a')]);
    expect(deriveSelection(after, [K('a')], G).shown).toEqual([K('a')]);
  });

  it('survives a sequence that would break a mutable model', () => {
    // A dependency's box is already checked, so clicking it is an UNCHECK and
    // cannot promote it to a hand pick. The reachable sequence is therefore:
    // check `a`, uncheck `b` (which clears `a` too), then pick `b` on its own.
    let s = toggle(sel([]), [], G, K('a'));
    expect(deriveSelection(s, [], G).shown.sort()).toEqual([K('a'), K('b'), K('c')].sort());
    s = toggle(s, [], G, K('b'));
    expect(s.explicit).toEqual([]);
    expect(deriveSelection(s, [], G).shown).toEqual([]);
    s = toggle(s, [], G, K('b'));
    expect(s.explicit).toEqual([K('b')]);
    expect(deriveSelection(s, [], G).dependency).toEqual([K('c')]);
    s = toggle(s, [], G, K('b'));
    expect(deriveSelection(s, [], G).shown).toEqual([]);
  });

  it('is idempotent under check then uncheck', () => {
    const start = sel([K('d')]);
    const round = toggle(toggle(start, [], G, K('a')), [], G, K('a'));
    expect(round.explicit).toEqual(start.explicit);
  });
});

describe('applyCheckChange', () => {
  const BRANCH = [K('g/x'), K('g/y'), K('g/z')];
  const PAIR = [K('p/dependent'), K('p/dependency')];

  it('checking a branch makes every leaf of it an explicit pick', () => {
    const before = sel([K('g/x')]);
    const shown = deriveSelection(before, [], G).shown;
    const after = applyCheckChange(before, [], G, shown, BRANCH);
    expect(after.explicit.slice().sort()).toEqual(BRANCH.slice().sort());
  });

  it('unchecking a branch clears every leaf of it', () => {
    const before = sel([...BRANCH]);
    const shown = deriveSelection(before, [], G).shown;
    const after = applyCheckChange(before, [], G, shown, []);
    expect(after.explicit).toEqual([]);
  });

  it('does not promote a dependency to a hand pick when its dependent is unchecked', () => {
    // The removal-direction guard, on the two-node chain that makes it visible.
    // The tree reports both leaves going off; dropping the dependent already
    // drops the dependency, and an unguarded fold would then find the
    // dependency's box off and turn it back ON as an explicit pick -- landing on
    // `[p/dependency]`, a hand pick the user made by UNCHECKING something.
    const before = sel([K('p/dependent')]);
    const shown = deriveSelection(before, [], G).shown;
    expect(shown.slice().sort()).toEqual(PAIR.slice().sort());
    const after = applyCheckChange(before, [], G, shown, []);
    expect(after.explicit).toEqual([]);
    expect(deriveSelection(after, [], G).shown).toEqual([]);
  });

  it('checking a branch makes a dependency inside it explicit, not a dependency', () => {
    // The user's click covered BOTH boxes by hand, so neither is an auto
    // selection and neither may be shown as one.
    const after = applyCheckChange(sel([]), [], G, [], PAIR);
    expect(after.explicit).toEqual(PAIR);
    expect(deriveSelection(after, [], G).dependency).toEqual([]);
  });

  it('leaves a branch-checked dependency standing when its dependent goes off', () => {
    const checked = applyCheckChange(sel([]), [], G, [], PAIR);
    const shown = deriveSelection(checked, [], G).shown;
    const after = applyCheckChange(checked, [], G, shown, [K('p/dependency')]);
    expect(after.explicit).toEqual([K('p/dependency')]);
    expect(deriveSelection(after, [], G).shown).toEqual([K('p/dependency')]);
  });

  it('still converges to empty when a branch-checked pair is unchecked whole', () => {
    const checked = applyCheckChange(sel([]), [], G, [], PAIR);
    const shown = deriveSelection(checked, [], G).shown;
    expect(applyCheckChange(checked, [], G, shown, []).explicit).toEqual([]);
  });

  it('folds removals before additions, so a new pick survives the change', () => {
    // `b` is the hand pick, `c` its dependency; the user replaces the whole
    // selection with `a`. Additions first would add `a`, then unchecking `b`
    // would take `a` down with it as a dependent -- wiping the new pick.
    const before = sel([K('b')]);
    const shown = deriveSelection(before, [], G).shown;
    expect(shown).toEqual([K('b'), K('c')]);
    const after = applyCheckChange(before, [], G, shown, [K('a')]);
    expect(after.explicit).toEqual([K('a')]);
  });

  it('is a no-op when nothing changed', () => {
    const before = sel([K('a')]);
    const shown = deriveSelection(before, [], G).shown;
    expect(applyCheckChange(before, [], G, shown, shown)).toBe(before);
  });

  it('keeps an installed dependent when the branch leaf it needs is unchecked', () => {
    // `w` is installed and needs `h/u`. Unchecking branch `h` must not queue an
    // uninstall of `w`, which is the installed-dependent guard in `toggle`.
    const branch = [K('h/u'), K('h/v')];
    const before = sel([K('w'), ...branch]);
    const shown = deriveSelection(before, [K('w')], G).shown;
    const after = applyCheckChange(before, [K('w')], G, shown, [K('w')]);
    expect(after.explicit).toEqual([K('w')]);
  });
});

describe('restore', () => {
  it('adds the skill to the restored set once', () => {
    expect(restore(restore(sel([K('a')]), K('a')), K('a')).restored).toEqual([K('a')]);
  });

  it('leaves the explicit set untouched', () => {
    expect(restore(sel([K('a')]), K('a')).explicit).toEqual([K('a')]);
  });
});

describe('dropMissing', () => {
  // `x` requires `ghost`, which no repository and no ledger entry mentions.
  const graph = buildGraph([mk('x', ['ghost']), mk('y')], []);
  const X = 'r1::::x';
  const GHOST = 'r1::::ghost';

  it('keeps an unresolvable reference out of the checked set', () => {
    const derived = deriveSelection({ explicit: [X], restored: [] }, [], graph);
    // The derivation itself still reports it -- that is what makes the leaf
    // visibly broken rather than silently fine.
    expect(derived.shown).toEqual([X, GHOST]);
    expect(derived.dependency).toEqual([GHOST]);

    const real = dropMissing(graph, derived);
    expect(real.shown).toEqual([X]);
    expect(real.dependency).toEqual([]);
  });

  it('leaves a selection of real skills untouched', () => {
    const derived = deriveSelection({ explicit: [X, 'r1::::y'], restored: [] }, [], graph);
    expect(dropMissing(graph, derived).shown).toEqual([X, 'r1::::y']);
  });

  it('is empty input safe', () => {
    expect(dropMissing(graph, { shown: [], dependency: [] })).toEqual({ shown: [], dependency: [] });
  });
});
