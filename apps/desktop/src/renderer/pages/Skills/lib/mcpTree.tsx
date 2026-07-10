/**
 * MCP leaves for the Skills page tree (design spec "MCP support" section 8,
 * option B): repo-discovered MCP presets render inline with skill leaves,
 * using the `mcp` icon and a caller-supplied trailing control (an
 * Install/Remove badge) in place of a checkbox -- the checkbox column stays
 * empty for these rows (see `TreeView`'s `trailing` handling).
 *
 * These functions build tree SHAPE only (ids, nesting, icon, label, and
 * whatever `renderTrailing` returns for the trailing slot); the actual
 * interactive badge -- opening the install modal or calling `applyMcp` to
 * remove -- is supplied by `SkillsPage`, mirroring how its own
 * `buildLabel`/`decorate` step layers interactivity onto the structural nodes
 * from `buildRepoTree`/`buildProjectModel`.
 *
 * This file lives in `pages/Skills/lib` rather than `entities/skill/lib`
 * because it needs the `McpPreset`/`McpInstall` shapes, and `entities` may not
 * import from `app` (see architecture.md's import boundaries) while `pages`
 * may reach the typed store surface at `@/app/store`.
 *
 * Project-mode model (revised -- a repo preset never disappears just because
 * an instance of it is installed, so the same preset can be installed more
 * than once):
 *   - every repo preset always renders an install-only leaf, nested under its
 *     repo/group node, regardless of how many instances of it exist;
 *   - each currently-installed instance of that preset (its identity matches
 *     the preset's remote/group/source) additionally renders a named
 *     "<source> <n>" remove-only leaf right beside the preset -- one leaf per
 *     distinct instance-config name, so installing the same preset twice
 *     (`github_1`, `github_2`) shows two separate rows; installing once for
 *     several agents (which share one instance-config name) still collapses
 *     to a single row;
 *   - an installed instance whose identity matches NO current preset (its
 *     source repo was untracked, or a manual preset was deleted) is
 *     "unlinked": it renders muted and remove-only under a synthetic node
 *     keyed off its identity's remote (or `local` id, or bare source when
 *     neither is present) -- mirroring `entities/skill/lib/skillTree.tsx`'s
 *     orphan-skill handling (muted row, synthetic node for a since-untracked
 *     source) -- rather than disappearing or floating unParented at the
 *     project root.
 *
 * Node id scheme (an `mcp::`-family prefix keeps this id space disjoint from
 * skillTree's skill-leaf keys, so an MCP leaf id can never collide with, or be
 * mistaken for, a skill leaf id -- and so it never enters the checkbox
 * selection or the apply-plan math, which only ever look up skill-shaped
 * keys; `parseProjectSkillKey` splits any key on `::` and matches its first
 * segment against a real project id, so none of these ever pass that check
 * regardless of which `mcp*` prefix is used):
 *   - repo mode leaf:                 `mcp::<presetId>`
 *   - project mode, preset (install): `mcp-preset::<projectId>::<presetId>`
 *   - project mode, instance (remove): `mcp-inst::<projectId>::<instanceKey>`
 *   - project mode, unlinked node:    `mcp-unlinked::<projectId>::<groupKey>`
 *   - project mode, unlinked leaf:    `mcp-inst::<projectId>::unlinked::<instanceKey>`
 */
import type { ReactNode } from 'react';
import { Icon } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import type { McpPreset } from '@/app/store';
import { normalizeMcpRemote } from '@/app/store';
import type { McpInstall, Repository, Project } from '@/services/bridge';
import {
  repoNodeId,
  repoGroupNodeId,
  projectNodeId,
  projectRepoNodeId,
  projectGroupNodeId,
} from '@/entities/skill';

const SEP = '::';

const mcpIcon = <Icon name="mcp" size={18} />;
// Installable PRESET leaves show the mcp glyph in the accent color to set them
// apart from already-installed (concrete) instances, which use the default
// (gray) glyph.
const mcpIconPreset = <Icon name="mcp" size={18} className="sk-mcp-icon--preset" />;
const repoIcon = <Icon name="repositories" size={18} />;
const groupIcon = <Icon name="skill-group" size={18} />;
const projectIcon = <Icon name="projects" size={18} />;

/** A repo-origin preset, narrowed to guarantee `repoId` is present. */
type RepoPreset = McpPreset & { readonly repoId: string };

function isRepoPreset(p: McpPreset): p is RepoPreset {
  return p.origin === 'repo' && p.repoId !== undefined;
}

/** Stable id for a repo-mode MCP leaf. */
export function mcpRepoLeafId(presetId: string): string {
  return ['mcp', presetId].join(SEP);
}

/** Stable id for a project-mode preset (install-only) leaf. */
export function mcpProjectPresetLeafId(projectId: string, presetId: string): string {
  return ['mcp-preset', projectId, presetId].join(SEP);
}

/** Stable id for a project-mode named-instance (remove-only) leaf. */
export function mcpProjectInstanceLeafId(projectId: string, instanceKey: string): string {
  return ['mcp-inst', projectId, instanceKey].join(SEP);
}

/** Stable id for the synthetic node an unlinked instance nests under. */
export function mcpUnlinkedNodeId(projectId: string, groupKey: string): string {
  return ['mcp-unlinked', projectId, groupKey].join(SEP);
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
 *  for collapses into one row, so installing the same preset for several
 *  agents at once (which share one instance-config name) still yields a
 *  single row, while installing it a second time (a fresh, differently-
 *  numbered instance name) yields a second, separate row. */
function instanceKey(identity: McpInstall['identity'], instanceName: string): string {
  return `${identityKey(identity)}|${instanceName}`;
}

/** Display label for an installed instance: its source name plus the numeric
 *  suffix parsed off its instance-config name (`github_1` -> `github 1`), per
 *  the `<snake>_<n>` naming convention in `packages/core/src/mcpNaming.ts`.
 *  Falls back to the bare source when the instance name does not follow that
 *  convention (should not happen for a SkillKeeper-managed instance). */
function instanceDisplayName(source: string, instanceName: string): string {
  const m = /_(\d+)$/.exec(instanceName);
  return m !== null ? `${source} ${m[1]}` : source;
}

/** Human-friendly label from a remote URL, e.g. `git@github.com:acme/x.git` ->
 *  `acme/x`. Mirrors `entities/skill/lib/skillTree.tsx`'s private
 *  `repoLabelFromRemote` (not exported across the entity boundary); duplicated
 *  here for the same reason `app/store/store.ts` duplicates core's small pure
 *  algorithms rather than importing them into the renderer. */
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
 *  preset id, else its raw source name. Installs sharing one of these collapse
 *  under one node, mirroring how `skillTree` groups an untracked repo's
 *  orphan skills under one synthetic repo node. */
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

/** The action a row's trailing badge performs: install a preset (optionally
 *  into a preselected project), or remove one or more installed instances
 *  (one per agent) that all represent the same installed MCP server. */
export type McpRowAction =
  | { readonly kind: 'install'; readonly preset: McpPreset; readonly projectId?: string }
  | { readonly kind: 'remove'; readonly installs: readonly McpInstall[] };

interface PlacedLeaf {
  readonly repoId?: string;
  readonly group?: string;
  readonly leaf: TreeNode;
}

/**
 * Merge leaves into a repo -> (group ->) leaves structure, creating repo/group
 * nodes that do not already exist (e.g. a repo whose only content is an MCP
 * preset, with no skills at all). Leaves are appended after any existing
 * children in their target node, per "place MCP leaves after skill leaves".
 */
function mergeIntoRepoGroups(
  nodes: readonly TreeNode[],
  items: readonly PlacedLeaf[],
  repos: readonly Repository[],
  repoNodeIdFor: (repoId: string) => string,
  groupNodeIdFor: (repoId: string, group: string) => string,
  /** True when a freshly-created repo node is a top-level tree root (repo
   *  mode, mirrors `buildRepoTree`'s `selectable: false`); false when it is
   *  nested under a project (project mode, mirrors `buildProjectModel`'s
   *  repo nodes, which set no `selectable` field). */
  isTopLevelRoot: boolean,
): TreeNode[] {
  const byRepo = new Map<string, PlacedLeaf[]>();
  for (const it of items) {
    if (it.repoId === undefined) continue;
    const list = byRepo.get(it.repoId);
    if (list !== undefined) list.push(it);
    else byRepo.set(it.repoId, [it]);
  }
  if (byRepo.size === 0) return [...nodes];

  let out = [...nodes];
  for (const repo of repos) {
    const its = byRepo.get(repo.id);
    if (its === undefined || its.length === 0) continue;

    const rid = repoNodeIdFor(repo.id);
    const idx = out.findIndex((n) => n.id === rid);
    const base: TreeNode =
      idx === -1
        ? {
            id: rid,
            label: repo.name,
            icon: repoIcon,
            children: [],
            ...(isTopLevelRoot ? { selectable: false } : {}),
          }
        : out[idx]!;

    let children = [...(base.children ?? [])];
    const byGroup = new Map<string | undefined, TreeNode[]>();
    for (const it of its) {
      const list = byGroup.get(it.group);
      if (list !== undefined) list.push(it.leaf);
      else byGroup.set(it.group, [it.leaf]);
    }
    for (const [group, leaves] of byGroup) {
      if (group === undefined || group === '') {
        children = [...children, ...leaves];
        continue;
      }
      const gId = groupNodeIdFor(repo.id, group);
      const gIdx = children.findIndex((c) => c.id === gId);
      if (gIdx === -1) {
        children = [...children, { id: gId, label: group, icon: groupIcon, children: leaves }];
      } else {
        const g = children[gIdx]!;
        children[gIdx] = { ...g, children: [...(g.children ?? []), ...leaves] };
      }
    }

    const updated = { ...base, children };
    if (idx === -1) out = [...out, updated];
    else out[idx] = updated;
  }
  return out;
}

/**
 * Attach repo-origin MCP presets as leaves under `buildRepoTree`'s output
 * (repositories mode): each preset appears under its repo (and group, if any),
 * after the skill leaves, with an Install badge (no project preselected).
 * Manual presets and presets whose repo is not in `repos` (filtered out, or
 * untracked) are skipped -- they have no place in this repo-nested tree.
 */
export function attachRepoMcpLeaves(
  nodes: readonly TreeNode[],
  presets: readonly McpPreset[],
  repos: readonly Repository[],
  renderTrailing: (preset: McpPreset) => ReactNode,
): TreeNode[] {
  const repoPresets = [...presets]
    .filter(isRepoPreset)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (repoPresets.length === 0) return [...nodes];

  const items: PlacedLeaf[] = repoPresets.map((p) => ({
    repoId: p.repoId,
    group: p.group,
    leaf: { id: mcpRepoLeafId(p.id), label: p.name, icon: mcpIconPreset, trailing: renderTrailing(p) },
  }));

  return mergeIntoRepoGroups(nodes, items, repos, repoNodeId, repoGroupNodeId, true);
}

interface ProjectMcpRow {
  readonly repoId?: string;
  readonly group?: string;
  readonly label: string;
  readonly leafId: string;
  readonly action: McpRowAction;
}

/** One synthetic node's worth of unlinked (no-preset-match) rows. */
interface UnlinkedGroup {
  readonly groupKey: string;
  readonly label: string;
  readonly rows: ProjectMcpRow[];
}

/**
 * Compute one project's MCP rows for the current model (see the file header):
 * every repo preset gets a persistent install row (`nested`, so the same
 * preset can be installed more than once), plus one named remove row per
 * distinct installed instance that matches it (also `nested`, alongside its
 * preset); installs matching no current preset are returned separately
 * (`unlinkedGroups`), bucketed by source, for the caller to nest under a
 * synthetic muted node instead of a repo/group.
 */
function projectMcpRows(
  projectId: string,
  repoPresets: readonly RepoPreset[],
  installs: readonly McpInstall[],
): { readonly nested: ProjectMcpRow[]; readonly unlinkedGroups: UnlinkedGroup[] } {
  const projectInstalls = installs.filter((i) => i.projectId === projectId);
  const consumed = new Set<McpInstall>();
  const nested: ProjectMcpRow[] = [];

  const sortedPresets = [...repoPresets].sort((a, b) => a.name.localeCompare(b.name));
  for (const preset of sortedPresets) {
    nested.push({
      repoId: preset.repoId,
      group: preset.group,
      label: preset.name,
      leafId: mcpProjectPresetLeafId(projectId, preset.id),
      action: { kind: 'install', preset, projectId },
    });

    const matches = projectInstalls.filter((inst) => identityMatchesRepoPreset(inst.identity, preset));
    const byInstance = new Map<string, McpInstall[]>();
    for (const m of matches) {
      consumed.add(m);
      const key = instanceKey(m.identity, m.instanceName);
      const list = byInstance.get(key);
      if (list !== undefined) list.push(m);
      else byInstance.set(key, [m]);
    }
    const groups = [...byInstance.values()].sort((a, b) =>
      a[0]!.instanceName.localeCompare(b[0]!.instanceName),
    );
    for (const group of groups) {
      const first = group[0]!;
      nested.push({
        repoId: preset.repoId,
        group: preset.group,
        label: instanceDisplayName(first.identity.source, first.instanceName),
        leafId: mcpProjectInstanceLeafId(projectId, instanceKey(first.identity, first.instanceName)),
        action: { kind: 'remove', installs: group },
      });
    }
  }

  const byInstanceUnmatched = new Map<string, McpInstall[]>();
  for (const inst of projectInstalls) {
    if (consumed.has(inst)) continue;
    const key = instanceKey(inst.identity, inst.instanceName);
    const list = byInstanceUnmatched.get(key);
    if (list !== undefined) list.push(inst);
    else byInstanceUnmatched.set(key, [inst]);
  }

  const byGroupKey = new Map<string, UnlinkedGroup>();
  for (const group of byInstanceUnmatched.values()) {
    const first = group[0]!;
    const groupKey = unlinkedGroupKey(first.identity);
    const row: ProjectMcpRow = {
      label: instanceDisplayName(first.identity.source, first.instanceName),
      leafId: mcpProjectInstanceLeafId(
        projectId,
        `unlinked${SEP}${instanceKey(first.identity, first.instanceName)}`,
      ),
      action: { kind: 'remove', installs: group },
    };
    const bucket = byGroupKey.get(groupKey);
    if (bucket !== undefined) bucket.rows.push(row);
    else byGroupKey.set(groupKey, { groupKey, label: unlinkedGroupLabel(first.identity), rows: [row] });
  }
  const unlinkedGroups = [...byGroupKey.values()]
    .map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { nested, unlinkedGroups };
}

/**
 * Attach MCP leaves under `buildProjectModel`'s output (projects mode), per
 * project: every repo preset gets a persistent install leaf nested under its
 * repo/group node (see the file header -- it never disappears just because an
 * instance exists); each matching installed instance gets a named remove leaf
 * right beside it; any installed instance matching no current preset
 * ("unlinked") renders muted and remove-only under a synthetic node, one per
 * distinct source, appended as a direct child of the project root (alongside
 * the repo nodes) -- same placement skillTree uses for an untracked repo's
 * orphan skills.
 */
export function attachProjectMcpLeaves(
  nodes: readonly TreeNode[],
  presets: readonly McpPreset[],
  installs: readonly McpInstall[],
  projects: readonly Project[],
  repos: readonly Repository[],
  renderTrailing: (action: McpRowAction) => ReactNode,
): TreeNode[] {
  const repoPresets = presets.filter(isRepoPreset);
  if (repoPresets.length === 0 && installs.length === 0) return [...nodes];

  let out = [...nodes];
  for (const project of projects) {
    const { nested, unlinkedGroups } = projectMcpRows(project.id, repoPresets, installs);
    if (nested.length === 0 && unlinkedGroups.length === 0) continue;

    const pid = projectNodeId(project.id);
    const idx = out.findIndex((n) => n.id === pid);
    const base: TreeNode =
      idx === -1
        ? { id: pid, label: project.name, icon: projectIcon, selectable: false, children: [] }
        : out[idx]!;

    const items: PlacedLeaf[] = nested.map((r) => ({
      repoId: r.repoId,
      group: r.group,
      leaf: {
        id: r.leafId,
        label: r.label,
        icon: r.action.kind === 'install' ? mcpIconPreset : mcpIcon,
        trailing: renderTrailing(r.action),
      },
    }));
    let children = mergeIntoRepoGroups(
      base.children ?? [],
      items,
      repos,
      (repoId) => projectRepoNodeId(project.id, repoId),
      (repoId, group) => projectGroupNodeId(project.id, repoId, group),
      false,
    );

    const unlinkedNodes: TreeNode[] = unlinkedGroups.map((g) => ({
      id: mcpUnlinkedNodeId(project.id, g.groupKey),
      label: g.label,
      icon: repoIcon,
      muted: true,
      children: g.rows.map((r) => ({
        id: r.leafId,
        label: r.label,
        icon: mcpIcon,
        trailing: renderTrailing(r.action),
        muted: true,
      })),
    }));
    children = [...children, ...unlinkedNodes];

    const updated = { ...base, children };
    if (idx === -1) out = [...out, updated];
    else out[idx] = updated;
  }
  return out;
}
