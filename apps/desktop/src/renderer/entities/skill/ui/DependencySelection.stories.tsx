/**
 * Interactive coverage for the skill-dependency selection feature, using the
 * REAL reducer -- `buildScopedGraph`, `deriveSelection`, `applyCheckChange`,
 * `restore` and `brokenLeaves` from this module -- rather than a
 * reimplementation. `shared/ui/TreeView.stories.tsx` covers the `dependencyIds`
 * PROP in isolation (a static set, no selection logic); this file is where a
 * reader can click through the actual behaviour, wired exactly the way
 * `pages/Skills/ManagementPage.tsx` wires it. `shared/ui` may not import from
 * `entities`, which is why this half of the coverage lives here instead.
 *
 * The catalog:
 *   - a chain:   a -> b -> c
 *   - a diamond: d -> b, e -> b
 *   - `f`, an INSTALLED leaf whose recorded dependency (`c`) exists in the
 *     catalog but is not installed -- its broken badge is clickable.
 *   - `g`, an INSTALLED leaf whose recorded dependency (`ghost`) exists
 *     NOWHERE -- its broken badge is deliberately not a button.
 *
 * Click through to see:
 *   1. Checking `a` tints `b` and `c` teal, transitively.
 *   2. Unchecking the teal `b` clears `a` (and `c`, which was only shown for
 *      `a`'s sake).
 *   3. Unchecking `a` (without touching `b`/`c` first) drops both again.
 *   4. Check `c` BEFORE `a`: `c` stays a hand pick (neutral, not teal) and
 *      survives unchecking `a` afterward, while `b` still drops.
 *   5. `f`'s orange exclamation is clickable; clicking it arms `c` for
 *      install (teal `add-dependency` badge). `f`'s own badge stays orange
 *      afterward -- restoring only QUEUES the install, it does not apply it,
 *      so `brokenLeaves` still reports `f` as broken until a real apply
 *      happens. That is the same behaviour the Management page has; it is
 *      not a story bug. `g`'s orange exclamation has no click handler at all
 *      and its tooltip says why, since `ghost` cannot be repaired from here.
 */
import { useCallback, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { AvailableSkill, InstallManifest } from '@/services/bridge';
import { TreeView, ChangeBadge } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { buildScopedGraph, brokenLeaves, closure, contains } from '../lib/requires';
import { deriveSelection, dropMissing, applyCheckChange, restore } from '../lib/selection';
import { installedLeafIds, projectSkillKey } from '../lib/skillTree';

const REPO_ID = 'repo-1';
const SCOPE_ID = 'proj-1';

function availableSkill(name: string, requires?: string[]): AvailableSkill {
  return {
    repoId: REPO_ID,
    repoName: 'acme/skills',
    remote: 'git@example.com:acme/skills.git',
    name,
    contentHash: `hash-${name}`,
    hasGuidance: false,
    ...(requires !== undefined ? { requires } : {}),
  };
}

function installedLeaf(name: string, requires: string[]): InstallManifest {
  return {
    skillId: { name },
    target: { agent: 'claude', scope: 'project', projectId: SCOPE_ID },
    destinationRoot: `/dest/${name}`,
    sourceRepoId: REPO_ID,
    sourceRemote: 'git@example.com:acme/skills.git',
    contentHash: `hash-${name}`,
    installedAt: '2026-08-21T00:00:00.000Z',
    files: [],
    hookEdits: [],
    requires,
  };
}

// Chain a -> b -> c, plus a diamond (d, e both need b). Neither installed.
const CATALOG: AvailableSkill[] = [
  availableSkill('a', ['b']),
  availableSkill('b', ['c']),
  availableSkill('c'),
  availableSkill('d', ['b']),
  availableSkill('e', ['b']),
];

// `f` is installed and missing `c` (repairable: `c` exists in the catalog and
// is not installed). `g` is installed and missing `ghost`, which exists in no
// catalog and no ledger entry -- not repairable.
const INSTALLS: InstallManifest[] = [installedLeaf('f', ['c']), installedLeaf('g', ['ghost'])];

const leafKey = (name: string): string => projectSkillKey(SCOPE_ID, REPO_ID, undefined, name);

const ROWS: readonly { readonly name: string; readonly label: string }[] = [
  { name: 'a', label: 'a (needs b)' },
  { name: 'b', label: 'b (needs c)' },
  { name: 'c', label: 'c' },
  { name: 'd', label: 'd (needs b)' },
  { name: 'e', label: 'e (needs b)' },
  { name: 'f', label: 'f -- installed, missing c' },
  { name: 'g', label: 'g -- installed, missing a skill that exists nowhere' },
];

function DependencySelectionDemo() {
  const graph = useMemo(() => buildScopedGraph([SCOPE_ID], CATALOG, INSTALLS), []);
  const baseline = useMemo(() => installedLeafIds(INSTALLS), []);
  const installedSet = useMemo(() => new Set(baseline), [baseline]);
  const brokenByLeaf = useMemo(() => brokenLeaves({ scopeId: SCOPE_ID, available: CATALOG, installs: INSTALLS }), []);

  // Of the broken leaves, the ones a repair could actually do something for --
  // mirrors `ManagementPage`'s own `repairableLeaves` exactly.
  const repairableLeaves = useMemo(() => {
    const out = new Set<string>();
    for (const leaf of brokenByLeaf.keys()) {
      const canFix = closure(graph, [leaf]).some((id) => contains(graph, id) && !installedSet.has(id));
      if (canFix) out.add(leaf);
    }
    return out;
  }, [brokenByLeaf, graph, installedSet]);

  // Start checked exactly as installed, like a freshly opened Management page.
  const [checked, setChecked] = useState<string[]>(() => [...baseline]);
  const [repaired, setRepaired] = useState<string[]>([]);

  const selection = useMemo(
    () => dropMissing(graph, deriveSelection({ explicit: checked, restored: repaired }, baseline, graph)),
    [checked, repaired, baseline, graph],
  );
  const shownSet = useMemo(() => new Set(selection.shown), [selection]);
  const dependencySet = useMemo(() => new Set(selection.dependency), [selection]);

  const onCheckedChange = (next: string[]): void => {
    const updated = applyCheckChange({ explicit: checked, restored: repaired }, baseline, graph, selection.shown, next);
    setChecked([...updated.explicit]);
    setRepaired([...updated.restored]);
  };

  const onRepair = useCallback(
    (leaf: string): void => {
      setRepaired([...restore({ explicit: checked, restored: repaired }, leaf).restored]);
    },
    [checked, repaired],
  );

  const nodes: TreeNode[] = useMemo(
    () => [
      {
        id: 'repo',
        label: 'acme/skills',
        selectable: false,
        children: ROWS.map(({ name, label }) => {
          const id = leafKey(name);
          const wasInstalled = installedSet.has(id);
          const isChecked = shownSet.has(id);
          const isDependency = dependencySet.has(id);
          const broken = brokenByLeaf.get(id);
          let detail: TreeNode['detail'];
          if (broken !== undefined && !isDependency) {
            const repairable = repairableLeaves.has(id);
            detail = (
              <ChangeBadge
                kind="broken"
                label={
                  repairable
                    ? `A required skill was removed (${broken.join(', ')}); click to restore it.`
                    : `A required skill was removed (${broken.join(', ')}), but it is not available in any known repository, so it cannot be reinstalled from here.`
                }
                onClick={repairable ? () => onRepair(id) : undefined}
              />
            );
          } else if (wasInstalled && isChecked) {
            detail = <ChangeBadge kind="present" label="Skill already installed" />;
          } else if (wasInstalled && !isChecked) {
            detail = <ChangeBadge kind="remove" label="Skill will be removed" />;
          } else if (!wasInstalled && isChecked) {
            detail = (
              <ChangeBadge
                kind={isDependency ? 'add-dependency' : 'add'}
                label={isDependency ? 'Will be installed as a dependency of another skill' : 'Skill will be added'}
              />
            );
          }
          return { id, label, detail };
        }),
      },
    ],
    [shownSet, dependencySet, brokenByLeaf, repairableLeaves, installedSet, onRepair],
  );

  return (
    <div style={{ width: 420 }}>
      <TreeView
        nodes={nodes}
        checkable
        checkedIds={selection.shown}
        dependencyIds={selection.dependency}
        onCheckedChange={onCheckedChange}
        defaultExpandedIds={['repo']}
        ariaLabel="Dependency selection"
      />
    </div>
  );
}

const meta: Meta<typeof DependencySelectionDemo> = {
  title: 'entities/skill/DependencySelection',
  component: DependencySelectionDemo,
};
export default meta;
type Story = StoryObj<typeof DependencySelectionDemo>;

export const Default: Story = {};
