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
 * Node id scheme (an `mcp::` prefix keeps this id space disjoint from
 * skillTree's skill-leaf keys, so an MCP leaf id can never collide with, or be
 * mistaken for, a skill leaf id -- and so it never enters the checkbox
 * selection or the apply-plan math, which only ever look up skill-shaped
 * keys):
 *   - repo mode leaf:            `mcp::<presetId>`
 *   - project mode, not installed: `mcp::<projectId>::<presetId>`
 *   - project mode, installed:   `mcp::<projectId>::install::<identityKey>`
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

/** Stable id for a project-mode "not yet installed" MCP leaf. */
export function mcpProjectPresetLeafId(projectId: string, presetId: string): string {
  return ['mcp', projectId, presetId].join(SEP);
}

/** Stable id for a project-mode "installed instance" MCP leaf. */
export function mcpProjectInstallLeafId(projectId: string, identityKey: string): string {
  return ['mcp', projectId, 'install', identityKey].join(SEP);
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

/** A stable grouping key for installs whose identity matches no current
 *  preset (e.g. a manual install, or one whose source repo was untracked) --
 *  installs sharing the same identity (across agents) collapse into one row. */
function identityKey(identity: McpInstall['identity']): string {
  if (identity.local !== undefined) return `local:${identity.local}`;
  return `remote:${normalizeMcpRemote(identity.remote ?? '')}|${identity.group ?? ''}|${identity.source}`;
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
    leaf: { id: mcpRepoLeafId(p.id), label: p.name, icon: mcpIcon, trailing: renderTrailing(p) },
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

/** Compute one project's MCP rows: a "remove" row per repo preset that has a
 *  matching install (grouping every agent's instance into one row), an
 *  "install" row per repo preset with none, and a "remove" row for any install
 *  matching no current preset (manual origin, or its source repo untracked). */
function projectMcpRows(
  projectId: string,
  repoPresets: readonly RepoPreset[],
  installs: readonly McpInstall[],
): ProjectMcpRow[] {
  const projectInstalls = installs.filter((i) => i.projectId === projectId);
  const consumed = new Set<McpInstall>();
  const rows: ProjectMcpRow[] = [];

  for (const preset of repoPresets) {
    const matches = projectInstalls.filter((inst) => identityMatchesRepoPreset(inst.identity, preset));
    if (matches.length > 0) {
      for (const m of matches) consumed.add(m);
      rows.push({
        repoId: preset.repoId,
        group: preset.group,
        label: preset.name,
        leafId: mcpProjectInstallLeafId(projectId, preset.id),
        action: { kind: 'remove', installs: matches },
      });
    } else {
      rows.push({
        repoId: preset.repoId,
        group: preset.group,
        label: preset.name,
        leafId: mcpProjectPresetLeafId(projectId, preset.id),
        action: { kind: 'install', preset, projectId },
      });
    }
  }

  const byIdentity = new Map<string, McpInstall[]>();
  for (const inst of projectInstalls) {
    if (consumed.has(inst)) continue;
    const key = identityKey(inst.identity);
    const list = byIdentity.get(key);
    if (list !== undefined) list.push(inst);
    else byIdentity.set(key, [inst]);
  }
  for (const [key, group] of byIdentity) {
    const first = group[0]!;
    rows.push({
      label: first.identity.source,
      leafId: mcpProjectInstallLeafId(projectId, key),
      action: { kind: 'remove', installs: group },
    });
  }

  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Attach MCP leaves under `buildProjectModel`'s output (projects mode), per
 * project: installed instances (grouped across agents) as "Remove" leaves,
 * repo presets not yet installed as "Install MCP" leaves (project
 * preselected), both nested under the matching repo/group node; installs
 * whose identity matches no current repo preset render directly under the
 * project root (unmanaged-style), same as the skill tree's own orphan
 * skills.
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
    const rows = projectMcpRows(project.id, repoPresets, installs);
    if (rows.length === 0) continue;

    const pid = projectNodeId(project.id);
    const idx = out.findIndex((n) => n.id === pid);
    const base: TreeNode =
      idx === -1
        ? { id: pid, label: project.name, icon: projectIcon, selectable: false, children: [] }
        : out[idx]!;

    const nested = rows.filter((r) => r.repoId !== undefined);
    const rootLevel = rows.filter((r) => r.repoId === undefined);

    const items: PlacedLeaf[] = nested.map((r) => ({
      repoId: r.repoId,
      group: r.group,
      leaf: { id: r.leafId, label: r.label, icon: mcpIcon, trailing: renderTrailing(r.action) },
    }));
    let children = mergeIntoRepoGroups(
      base.children ?? [],
      items,
      repos,
      (repoId) => projectRepoNodeId(project.id, repoId),
      (repoId, group) => projectGroupNodeId(project.id, repoId, group),
      false,
    );
    const rootLeaves: TreeNode[] = rootLevel.map((r) => ({
      id: r.leafId,
      label: r.label,
      icon: mcpIcon,
      trailing: renderTrailing(r.action),
    }));
    children = [...children, ...rootLeaves];

    const updated = { ...base, children };
    if (idx === -1) out = [...out, updated];
    else out[idx] = updated;
  }
  return out;
}
