/**
 * Standalone MCP-only tree builders for the MCP page. The MCP page is a
 * Skills-like TREE page in its own right (its own tree, modes, search) --
 * these builders produce a full MCP tree from scratch, unlike the retired
 * `attachRepoMcpLeaves`/`attachProjectMcpLeaves` in the old
 * `pages/Skills/lib/mcpTree.tsx`, which merged MCP leaves onto an existing
 * skills tree. MCP was removed from the Skills page; this module has no
 * dependency on the skills tree at all.
 *
 * Two pure builders:
 *  - `buildMcpRepoTree`: manual presets (top-level leaves, sorted by name) +
 *    one node per repository, nesting that repo's repo-origin presets under
 *    an optional group node -- mirrors `entities/skill/lib/skillTree.tsx`'s
 *    `buildRepoTree` repo/group nesting.
 *  - `buildMcpProjectTree`: manual presets (top-level leaves) + one node per
 *    project. Under each project: every repo preset always renders an
 *    install row (so the same preset can be installed more than once), each
 *    currently-installed instance whose identity matches that preset renders
 *    a named "<source> <n>" row right beside it; an installed instance whose
 *    identity's `local` matches a manual preset's id renders the same named
 *    row directly under the project (manual presets have no per-project
 *    "install row" -- their single top-level leaf covers every project); any
 *    installed instance matching NEITHER a repo NOR a manual preset
 *    ("unlinked") renders muted under a synthetic node keyed off its identity
 *    -- mirrors the project-mode model the old `attachProjectMcpLeaves`
 *    implemented, just built from scratch instead of merged into an existing
 *    tree.
 *
 * Both builders are pure (no store/bridge access, no side effects, React-free
 * apart from the existing `<Icon>` constants) and never set `trailing` -- the
 * page resolves each leaf id through the returned `items` lookup to decide
 * what badge and click behavior to render, keeping this module UI-decision
 * free and easy to unit test.
 *
 * Node id scheme (disjoint families; a `leaf` segment tags a leaf id
 * whenever a node id sharing its other segments also exists, so a leaf id
 * can never collide with a node id):
 *   - manual preset leaf (both modes, top level):  `mcp-manual::<presetId>`
 *   - repo mode repo root:                         `mcp-repo::<repoId>`
 *   - repo mode group node:                        `mcp-repo::<repoId>::<group>`
 *   - repo mode preset leaf:                       `mcp-repo::leaf::<presetId>`
 *   - project mode project root:                   `mcp-project::<projectId>`
 *   - project mode repo node:                       `mcp-repo::<projectId>::<repoId>`
 *   - project mode group node:                      `mcp-repo::<projectId>::<repoId>::<group>`
 *   - project mode repo-preset install-row leaf:    `mcp-repo::leaf::<projectId>::<presetId>`
 *   - project mode installed-instance leaf:         `mcp-inst::<projectId>::<instanceKey>`
 *   - project mode unlinked synthetic node:         `mcp-unlinked::<projectId>::<groupKey>`
 *   - project mode unlinked leaf:                   `mcp-inst::<projectId>::unlinked::<instanceKey>`
 */
import { Icon } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import type { McpPreset } from '@/app/store';
import { normalizeMcpRemote, mcpInstallHasUpdate } from '@/app/store';
import type { McpInstall, Repository, Project } from '@/services/bridge';

const SEP = '::';

const mcpIcon = <Icon name="mcp" size={18} />;
// Already-INSTALLED instances show the mcp glyph in the accent color; presets
// (manual or repo-origin) and unlinked instances use the default (gray) glyph.
const mcpIconInstalled = <Icon name="mcp" size={18} className="sk-mcp-icon--installed" />;
const repoIcon = <Icon name="repositories" size={18} />;
const groupIcon = <Icon name="mcp-group" size={18} />;
const projectIcon = <Icon name="projects" size={18} />;

/** What a leaf id resolves to, for the page's trailing-badge and click logic. */
export type McpTreeItem =
  | { readonly kind: 'manual-preset'; readonly preset: McpPreset }
  | { readonly kind: 'repo-preset'; readonly preset: McpPreset }
  | { readonly kind: 'installed'; readonly installs: readonly McpInstall[]; readonly updatable: boolean }
  | { readonly kind: 'unlinked'; readonly installs: readonly McpInstall[] };

export interface McpTreeResult {
  readonly nodes: TreeNode[];
  /** Leaf id -> item, for every leaf in `nodes`. */
  readonly items: ReadonlyMap<string, McpTreeItem>;
}

/** A repo-origin preset, narrowed to guarantee `repoId` is present. */
type RepoPreset = McpPreset & { readonly repoId: string };

function isRepoPreset(p: McpPreset): p is RepoPreset {
  return p.origin === 'repo' && p.repoId !== undefined;
}

const byName = (a: McpPreset, b: McpPreset): number => a.name.localeCompare(b.name);

/** Stable id for a top-level manual-preset leaf (both modes). */
export function mcpManualLeafId(presetId: string): string {
  return ['mcp-manual', presetId].join(SEP);
}

/** Stable id for a repo-mode repository root node. */
export function mcpRepoRootId(repoId: string): string {
  return ['mcp-repo', repoId].join(SEP);
}

/** Stable id for a repo-mode group node. */
export function mcpRepoGroupId(repoId: string, group: string): string {
  return ['mcp-repo', repoId, group].join(SEP);
}

/** Stable id for a repo-mode preset leaf. */
export function mcpRepoPresetLeafId(presetId: string): string {
  return ['mcp-repo', 'leaf', presetId].join(SEP);
}

/** Stable id for a project-mode project root node. */
export function mcpProjectRootId(projectId: string): string {
  return ['mcp-project', projectId].join(SEP);
}

/** Stable id for a project-mode repository node (nested under a project). */
export function mcpProjectRepoNodeId(projectId: string, repoId: string): string {
  return ['mcp-repo', projectId, repoId].join(SEP);
}

/** Stable id for a project-mode group node (nested under a project/repo). */
export function mcpProjectGroupNodeId(projectId: string, repoId: string, group: string): string {
  return ['mcp-repo', projectId, repoId, group].join(SEP);
}

/** Stable id for a project-mode repo-preset install-row leaf. */
export function mcpProjectPresetLeafId(projectId: string, presetId: string): string {
  return ['mcp-repo', 'leaf', projectId, presetId].join(SEP);
}

/** Stable id for a project-mode installed-instance leaf. */
export function mcpInstalledLeafId(projectId: string, key: string): string {
  return ['mcp-inst', projectId, key].join(SEP);
}

/** Stable id for the synthetic node an unlinked instance nests under. */
export function mcpUnlinkedNodeId(projectId: string, groupKey: string): string {
  return ['mcp-unlinked', projectId, groupKey].join(SEP);
}

/** Stable id for a project-mode unlinked-instance leaf. */
export function mcpUnlinkedLeafId(projectId: string, key: string): string {
  return ['mcp-inst', projectId, 'unlinked', key].join(SEP);
}

/** Whether an installed instance's identity matches a repo-origin preset. */
function identityMatchesRepoPreset(identity: McpInstall['identity'], preset: RepoPreset): boolean {
  return (
    identity.remote !== undefined &&
    preset.remote !== undefined &&
    normalizeMcpRemote(identity.remote) === normalizeMcpRemote(preset.remote) &&
    (identity.group ?? undefined) === preset.group &&
    identity.source === preset.name
  );
}

/** A stable grouping key for an install's identity (ignoring which specific
 *  instance-config name it landed under). */
function identityKey(identity: McpInstall['identity']): string {
  if (identity.local !== undefined) return `local:${identity.local}`;
  return `remote:${normalizeMcpRemote(identity.remote ?? '')}|${identity.group ?? ''}|${identity.source}`;
}

/** A stable grouping key for one logical installed instance: the same
 *  (identity, instance-config name) pair across every agent it is installed
 *  for collapses into one row. */
function instanceKey(identity: McpInstall['identity'], instanceName: string): string {
  return `${identityKey(identity)}|${instanceName}`;
}

/** Display label for an installed instance: its source name plus the numeric
 *  suffix parsed off its instance-config name (`github_1` -> `github 1`), per
 *  the `<snake>_<n>` naming convention in `packages/core/src/mcp/naming.ts`.
 *  Falls back to the bare source when the instance name does not follow that
 *  convention (should not happen for a SkillKeeper-managed instance). */
function instanceDisplayName(source: string, instanceName: string): string {
  const m = /_(\d+)$/.exec(instanceName);
  return m !== null ? `${source} ${m[1]}` : source;
}

/** Human-friendly label from a remote URL, e.g. `git@github.com:acme/x.git` ->
 *  `acme/x`. */
function repoLabelFromRemote(remote: string): string {
  let s = remote.trim().replace(/\.git$/, '');
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s);
  if (scp !== null) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : (parts[0] ?? remote);
}

/** Grouping key for the synthetic node an unlinked instance nests under --
 *  keyed off its identity's remote (normalized) when present, else its local
 *  preset id, else its raw source name. */
function unlinkedGroupKey(identity: McpInstall['identity']): string {
  if (identity.remote !== undefined) return `remote:${normalizeMcpRemote(identity.remote)}`;
  if (identity.local !== undefined) return `local:${identity.local}`;
  return `source:${identity.source}`;
}

/** Label for the synthetic unlinked-group node: a friendly repo name when the
 *  identity carries a remote, else its bare source name. */
function unlinkedGroupLabel(identity: McpInstall['identity']): string {
  return identity.remote !== undefined ? repoLabelFromRemote(identity.remote) : identity.source;
}

/**
 * Repositories -> (groups ->) repo-origin preset leaves, with the manual
 * presets as top-level leaves before the repo nodes. Manual presets and
 * presets whose repo is not in `repos` (filtered out, or untracked) have no
 * place in the given `repos` list and are simply not nested under any repo
 * node (manual presets still appear as top-level leaves; untracked-repo
 * presets are dropped, mirroring `buildRepoTree`'s `shownRepos` filtering).
 */
export function buildMcpRepoTree(presets: readonly McpPreset[], repos: readonly Repository[]): McpTreeResult {
  const items = new Map<string, McpTreeItem>();

  const manualLeaves: TreeNode[] = [...presets]
    .filter((p) => p.origin === 'manual')
    .sort(byName)
    .map((p) => {
      const id = mcpManualLeafId(p.id);
      items.set(id, { kind: 'manual-preset', preset: p });
      return { id, label: p.name, icon: mcpIcon };
    });

  const byRepo = new Map<string, RepoPreset[]>();
  for (const p of presets) {
    if (!isRepoPreset(p)) continue;
    const list = byRepo.get(p.repoId);
    if (list !== undefined) list.push(p);
    else byRepo.set(p.repoId, [p]);
  }

  const repoNodes: TreeNode[] = [];
  for (const repo of repos) {
    const ps = byRepo.get(repo.id);
    if (ps === undefined || ps.length === 0) continue;

    const groups = new Map<string, RepoPreset[]>();
    const ungrouped: RepoPreset[] = [];
    for (const p of ps) {
      if (p.group !== undefined && p.group !== '') {
        const list = groups.get(p.group);
        if (list !== undefined) list.push(p);
        else groups.set(p.group, [p]);
      } else ungrouped.push(p);
    }

    const makeLeaf = (p: RepoPreset): TreeNode => {
      const id = mcpRepoPresetLeafId(p.id);
      items.set(id, { kind: 'repo-preset', preset: p });
      return { id, label: p.name, icon: mcpIcon };
    };

    const children: TreeNode[] = [];
    for (const [group, gs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      children.push({
        id: mcpRepoGroupId(repo.id, group),
        label: group,
        icon: groupIcon,
        selectable: false,
        children: [...gs].sort(byName).map(makeLeaf),
      });
    }
    for (const p of [...ungrouped].sort(byName)) {
      children.push(makeLeaf(p));
    }

    repoNodes.push({ id: mcpRepoRootId(repo.id), label: repo.name, icon: repoIcon, selectable: false, children });
  }

  return { nodes: [...manualLeaves, ...repoNodes], items };
}

/**
 * Manual presets (top-level leaves) + one node per project. Under each
 * project: every repo preset (whose repo is in `repos`) always renders an
 * install row nested under its repo/group node, regardless of how many
 * instances of it exist; each currently-installed instance whose identity
 * matches that preset additionally renders a named "<source> <n>" row beside
 * it -- one row per distinct instance-config name, so installing the same
 * preset twice (`github_1`, `github_2`) shows two rows, while installing once
 * for several agents (which share one instance-config name) collapses to a
 * single row; any installed instance matching no current preset ("unlinked")
 * renders muted under a synthetic node, one per distinct source/remote,
 * appended as a direct child of the project root. An installed instance whose
 * identity's `local` matches a manual preset's id is never "unlinked" -- it
 * renders as an installed row directly under the project root instead (see
 * `manualInstanceLeaves` below).
 */
export function buildMcpProjectTree(
  presets: readonly McpPreset[],
  installs: readonly McpInstall[],
  projects: readonly Project[],
  repos: readonly Repository[],
): McpTreeResult {
  const items = new Map<string, McpTreeItem>();

  const manualLeaves: TreeNode[] = [...presets]
    .filter((p) => p.origin === 'manual')
    .sort(byName)
    .map((p) => {
      const id = mcpManualLeafId(p.id);
      items.set(id, { kind: 'manual-preset', preset: p });
      return { id, label: p.name, icon: mcpIcon };
    });

  const byRepo = new Map<string, RepoPreset[]>();
  for (const p of presets) {
    if (!isRepoPreset(p)) continue;
    const list = byRepo.get(p.repoId);
    if (list !== undefined) list.push(p);
    else byRepo.set(p.repoId, [p]);
  }

  const manualPresetIds = new Set(presets.filter((p) => p.origin === 'manual').map((p) => p.id));

  const projectNodes: TreeNode[] = [];
  for (const project of projects) {
    const projectInstalls = installs.filter((i) => i.projectId === project.id);
    const consumed = new Set<McpInstall>();

    const rowsFor = (p: RepoPreset): TreeNode[] => {
      const presetLeafId = mcpProjectPresetLeafId(project.id, p.id);
      items.set(presetLeafId, { kind: 'repo-preset', preset: p });
      const presetLeaf: TreeNode = { id: presetLeafId, label: p.name, icon: mcpIcon };

      const matches = projectInstalls.filter((inst) => identityMatchesRepoPreset(inst.identity, p));
      const byInstance = new Map<string, McpInstall[]>();
      for (const m of matches) {
        consumed.add(m);
        const key = instanceKey(m.identity, m.instanceName);
        const list = byInstance.get(key);
        if (list !== undefined) list.push(m);
        else byInstance.set(key, [m]);
      }
      const instanceGroups = [...byInstance.values()].sort((a, b) =>
        a[0]!.instanceName.localeCompare(b[0]!.instanceName),
      );
      const instanceLeaves: TreeNode[] = instanceGroups.map((group) => {
        const first = group[0]!;
        const key = instanceKey(first.identity, first.instanceName);
        const id = mcpInstalledLeafId(project.id, key);
        const updatable = mcpInstallHasUpdate(first, presets);
        items.set(id, { kind: 'installed', installs: group, updatable });
        return { id, label: instanceDisplayName(first.identity.source, first.instanceName), icon: mcpIconInstalled };
      });

      return [presetLeaf, ...instanceLeaves];
    };

    const repoChildren: TreeNode[] = [];
    for (const repo of repos) {
      const ps = byRepo.get(repo.id);
      if (ps === undefined || ps.length === 0) continue;

      const groups = new Map<string, RepoPreset[]>();
      const ungrouped: RepoPreset[] = [];
      for (const p of ps) {
        if (p.group !== undefined && p.group !== '') {
          const list = groups.get(p.group);
          if (list !== undefined) list.push(p);
          else groups.set(p.group, [p]);
        } else ungrouped.push(p);
      }

      const children: TreeNode[] = [];
      for (const [group, gs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        children.push({
          id: mcpProjectGroupNodeId(project.id, repo.id, group),
          label: group,
          icon: groupIcon,
          selectable: false,
          children: [...gs].sort(byName).flatMap(rowsFor),
        });
      }
      for (const p of [...ungrouped].sort(byName)) {
        children.push(...rowsFor(p));
      }

      repoChildren.push({ id: mcpProjectRepoNodeId(project.id, repo.id), label: repo.name, icon: repoIcon, selectable: false, children });
    }

    // Installed instances of a manual preset (identity.local === preset id):
    // render as named installed rows directly under the project root, keyed
    // by (identity, instance name) the same way a matched repo instance is --
    // just without a preset-leaf duplicate, since the manual preset already
    // has its one top-level leaf shared across every project.
    const matchedManual = projectInstalls.filter(
      (inst) => inst.identity.local !== undefined && manualPresetIds.has(inst.identity.local),
    );
    const byManualInstance = new Map<string, McpInstall[]>();
    for (const m of matchedManual) {
      consumed.add(m);
      const key = instanceKey(m.identity, m.instanceName);
      const list = byManualInstance.get(key);
      if (list !== undefined) list.push(m);
      else byManualInstance.set(key, [m]);
    }
    const manualInstanceLeaves: TreeNode[] = [...byManualInstance.values()]
      .sort((a, b) => a[0]!.instanceName.localeCompare(b[0]!.instanceName))
      .map((group) => {
        const first = group[0]!;
        const key = instanceKey(first.identity, first.instanceName);
        const id = mcpInstalledLeafId(project.id, key);
        const updatable = mcpInstallHasUpdate(first, presets);
        items.set(id, { kind: 'installed', installs: group, updatable });
        return { id, label: instanceDisplayName(first.identity.source, first.instanceName), icon: mcpIconInstalled };
      });

    // Unlinked: installs matching no current preset, bucketed by source/remote.
    const byInstanceUnmatched = new Map<string, McpInstall[]>();
    for (const inst of projectInstalls) {
      if (consumed.has(inst)) continue;
      const key = instanceKey(inst.identity, inst.instanceName);
      const list = byInstanceUnmatched.get(key);
      if (list !== undefined) list.push(inst);
      else byInstanceUnmatched.set(key, [inst]);
    }

    interface UnlinkedRow {
      readonly leaf: TreeNode;
      readonly sortLabel: string;
    }
    const byGroupKey = new Map<string, { readonly label: string; readonly rows: UnlinkedRow[] }>();
    for (const group of byInstanceUnmatched.values()) {
      const first = group[0]!;
      const groupKey = unlinkedGroupKey(first.identity);
      const key = instanceKey(first.identity, first.instanceName);
      const id = mcpUnlinkedLeafId(project.id, key);
      items.set(id, { kind: 'unlinked', installs: group });
      const label = instanceDisplayName(first.identity.source, first.instanceName);
      const leaf: TreeNode = { id, label, icon: mcpIcon, muted: true };
      const bucket = byGroupKey.get(groupKey);
      if (bucket !== undefined) bucket.rows.push({ leaf, sortLabel: label });
      else byGroupKey.set(groupKey, { label: unlinkedGroupLabel(first.identity), rows: [{ leaf, sortLabel: label }] });
    }
    const unlinkedNodes: TreeNode[] = [...byGroupKey.entries()]
      .map(([groupKey, g]) => ({ groupKey, label: g.label, rows: g.rows }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((g) => ({
        id: mcpUnlinkedNodeId(project.id, g.groupKey),
        label: g.label,
        icon: repoIcon,
        muted: true,
        selectable: false,
        children: [...g.rows].sort((a, b) => a.sortLabel.localeCompare(b.sortLabel)).map((r) => r.leaf),
      }));

    projectNodes.push({
      id: mcpProjectRootId(project.id),
      label: project.name,
      icon: projectIcon,
      selectable: false,
      children: [...repoChildren, ...manualInstanceLeaves, ...unlinkedNodes],
    });
  }

  return { nodes: [...manualLeaves, ...projectNodes], items };
}
