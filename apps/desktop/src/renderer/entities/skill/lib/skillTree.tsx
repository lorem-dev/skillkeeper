/**
 * Builders that turn the available-skills catalog, tracked repos/projects, and
 * install manifests into TreeView node trees for the Skills page, plus helpers
 * to fuzzy-filter the tree and collect expandable ids.
 *
 * Node id schemes (also used as checkbox keys, so they must be stable):
 *   - repo mode leaf:    `<repoId>::<group>::<name>`
 *   - project mode leaf: `<projectId>::<repoId>::<group>::<name>`
 * ('' stands in for a missing group.)
 */
import { Icon } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { fuzzyMatches } from '@/shared/lib';
import type {
  AgentKind,
  AvailableSkill,
  InstallManifest,
  Repository,
  Project,
  SkillRef,
} from '@/services/bridge';

const SEP = '::';

const repoIcon = <Icon name="repositories" size={18} />;
const groupIcon = <Icon name="skill-group" size={18} />;
const skillIcon = <Icon name="skills" size={18} />;
const projectIcon = <Icon name="projects" size={18} />;

/** Stable checkbox key for a repo-mode skill leaf. */
export function repoSkillKey(repoId: string, group: string | undefined, name: string): string {
  return [repoId, group ?? '', name].join(SEP);
}

/** Stable id for a repo-mode repository root node. */
export function repoNodeId(repoId: string): string {
  return `repo${SEP}${repoId}`;
}

/** Stable id for a repo-mode skill-group node. */
export function repoGroupNodeId(repoId: string, group: string): string {
  return `${repoId}${SEP}${group}`;
}

/** Stable id for a project-mode project root node. */
export function projectNodeId(projectId: string): string {
  return `proj${SEP}${projectId}`;
}

/** Stable id for a project-mode repository node (nested under a project). */
export function projectRepoNodeId(projectId: string, repoId: string): string {
  return `${projectId}${SEP}repo${SEP}${repoId}`;
}

/** Stable id for a project-mode skill-group node (nested under a project/repo). */
export function projectGroupNodeId(projectId: string, repoId: string, group: string): string {
  return `${projectId}${SEP}${repoId}${SEP}${group}`;
}

/** Stable checkbox key for a project-mode skill leaf. */
export function projectSkillKey(
  projectId: string,
  repoId: string,
  group: string | undefined,
  name: string,
): string {
  return [projectId, repoId, group ?? '', name].join(SEP);
}

/** A skill reference parsed from a checkbox key. */
export interface ParsedSkillRef {
  readonly repoId: string;
  readonly group?: string;
  readonly name: string;
}

/** Parse a repo-mode key `repoId::group::name`. */
export function parseRepoSkillKey(key: string): ParsedSkillRef {
  const [repoId = '', group = '', name = ''] = key.split(SEP);
  return { repoId, group: group === '' ? undefined : group, name };
}

/** Parse a project-mode key `projectId::repoId::group::name`. */
export function parseProjectSkillKey(key: string): ParsedSkillRef & { readonly projectId: string } {
  const [projectId = '', repoId = '', group = '', name = ''] = key.split(SEP);
  return { projectId, repoId, group: group === '' ? undefined : group, name };
}

function pushTo<K>(map: Map<K, AvailableSkill[]>, key: K, value: AvailableSkill): void {
  const arr = map.get(key);
  if (arr !== undefined) arr.push(value);
  else map.set(key, [value]);
}

const byName = (a: AvailableSkill, b: AvailableSkill): number => a.name.localeCompare(b.name);

/** Repositories -> (groups -> skills) or (-> skills). Roots are not selectable. */
export function buildRepoTree(available: readonly AvailableSkill[], repos: readonly Repository[]): TreeNode[] {
  const byRepo = new Map<string, AvailableSkill[]>();
  for (const s of available) pushTo(byRepo, s.repoId, s);

  const nodes: TreeNode[] = [];
  for (const repo of repos) {
    const skills = byRepo.get(repo.id);
    if (skills === undefined || skills.length === 0) continue;

    const groups = new Map<string, AvailableSkill[]>();
    const ungrouped: AvailableSkill[] = [];
    for (const s of skills) {
      if (s.group !== undefined && s.group !== '') pushTo(groups, s.group, s);
      else ungrouped.push(s);
    }

    const children: TreeNode[] = [];
    for (const [group, gs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      children.push({
        id: repoGroupNodeId(repo.id, group),
        label: group,
        icon: groupIcon,
        children: [...gs].sort(byName).map((s) => ({
          id: repoSkillKey(repo.id, s.group, s.name),
          label: s.name,
          icon: skillIcon,
        })),
      });
    }
    for (const s of [...ungrouped].sort(byName)) {
      children.push({ id: repoSkillKey(repo.id, undefined, s.name), label: s.name, icon: skillIcon });
    }

    nodes.push({ id: repoNodeId(repo.id), label: repo.name, icon: repoIcon, selectable: false, children });
  }
  return nodes;
}

/** Projects -> repositories -> (groups ->) skills. Roots are not selectable. */
export function buildProjectTree(
  available: readonly AvailableSkill[],
  repos: readonly Repository[],
  projects: readonly Project[],
): TreeNode[] {
  const byRepo = new Map<string, AvailableSkill[]>();
  for (const s of available) pushTo(byRepo, s.repoId, s);

  const nodes: TreeNode[] = [];
  for (const project of projects) {
    const repoNodes: TreeNode[] = [];
    for (const repo of repos) {
      const skills = byRepo.get(repo.id);
      if (skills === undefined || skills.length === 0) continue;

      const groups = new Map<string, AvailableSkill[]>();
      const ungrouped: AvailableSkill[] = [];
      for (const s of skills) {
        if (s.group !== undefined && s.group !== '') pushTo(groups, s.group, s);
        else ungrouped.push(s);
      }

      const children: TreeNode[] = [];
      for (const [group, gs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        children.push({
          id: projectGroupNodeId(project.id, repo.id, group),
          label: group,
          icon: groupIcon,
          children: [...gs].sort(byName).map((s) => ({
            id: projectSkillKey(project.id, repo.id, s.group, s.name),
            label: s.name,
            icon: skillIcon,
          })),
        });
      }
      for (const s of [...ungrouped].sort(byName)) {
        children.push({ id: projectSkillKey(project.id, repo.id, undefined, s.name), label: s.name, icon: skillIcon });
      }

      repoNodes.push({ id: projectRepoNodeId(project.id, repo.id), label: repo.name, icon: repoIcon, children });
    }
    nodes.push({ id: projectNodeId(project.id), label: project.name, icon: projectIcon, selectable: false, children: repoNodes });
  }
  return nodes;
}

/**
 * Status of a project-mode skill leaf:
 * - `available`: exists in a repo, not installed here (installable).
 * - `present`: installed and matches the repo content.
 * - `update`: installed but the repo content is newer (update available).
 * - `orphan`: installed but no longer available in any tracked repo (grey,
 *   remove-only) -- the repo was removed, or the skill was deleted/absent in
 *   the current branch.
 */
export type ProjectLeafStatus = 'available' | 'present' | 'update' | 'orphan';

/** A single skill to re-install in a project (from its current repository). */
export interface ProjectSkillUpdate {
  readonly projectId: string;
  readonly projectPath: string;
  readonly agents: AgentKind[];
  readonly ref: SkillRef;
  readonly repoId: string;
  readonly repoName: string;
}

/**
 * Extra badge for an orphan leaf:
 * - `unlinked`: its source repo is not tracked (removed, or arrived via git) --
 *   offer to add the repo, prefilled with `remote`.
 * - `local`: no known remote -- a skill written by hand in the project.
 * An orphan under a still-tracked repo (skill deleted from it) gets neither.
 */
export type OrphanLeafInfo = { readonly kind: 'unlinked'; readonly remote: string } | { readonly kind: 'local' };

/** The project-mode tree plus the status/update data the page decorates with. */
export interface ProjectModel {
  readonly nodes: TreeNode[];
  /** Leaf id -> status (for badges and muting). */
  readonly statusByLeaf: ReadonlyMap<string, ProjectLeafStatus>;
  /** Node id (leaf, group, or repo) -> updatable skills in its subtree. */
  readonly updatesByNode: ReadonlyMap<string, ProjectSkillUpdate[]>;
  /** Node id (leaf, or a dangling repo node) -> extra orphan badge (unlinked / local). */
  readonly orphanLeaves: ReadonlyMap<string, OrphanLeafInfo>;
}

/** Friendly repo label from a remote URL, e.g. `git@github.com:acme/x.git` -> `acme/x`. */
function repoLabelFromRemote(remote: string | undefined, fallback: string): string {
  if (remote === undefined || remote === '') return fallback;
  let s = remote.trim().replace(/\.git$/, '');
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s);
  if (scp !== null) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : (parts[0] ?? fallback);
}

interface LeafEntry {
  repoId: string;
  remote?: string;
  group?: string;
  name: string;
  available: boolean;
  availableHash?: string;
  installed: boolean;
  installedHash?: string;
  agents: AgentKind[];
}

function leafStatus(e: LeafEntry): ProjectLeafStatus {
  if (!e.installed) return 'available';
  if (!e.available) return 'orphan';
  if (
    e.installedHash !== undefined &&
    e.availableHash !== undefined &&
    e.installedHash !== e.availableHash
  ) {
    return 'update';
  }
  return 'present';
}

/**
 * Project mode with install status. Like {@link buildProjectTree} but merges the
 * installed manifests in, so orphaned installs (their repo removed, or the skill
 * gone from the current branch) still appear -- under their source repo, or under
 * a synthetic node labeled from the remote when nothing tracks it. Marks orphan
 * nodes `muted` (propagating up when every descendant is orphan) and collects the
 * updatable skills per node so the page can render update dots.
 *
 * `shownRepos` are the tracked repos to include (post repo-filter); dangling
 * (untracked-remote) installs are always shown so they can be removed.
 */
export function buildProjectModel(
  available: readonly AvailableSkill[],
  shownRepos: readonly Repository[],
  allRepos: readonly Repository[],
  projects: readonly Project[],
  installs: readonly InstallManifest[],
): ProjectModel {
  const shownRepoIds = new Set(shownRepos.map((r) => r.id));
  const trackedIds = new Set(allRepos.map((r) => r.id));
  const repoNameById = new Map(allRepos.map((r) => [r.id, r.name] as const));

  const statusByLeaf = new Map<string, ProjectLeafStatus>();
  const updatesByNode = new Map<string, ProjectSkillUpdate[]>();
  const orphanLeaves = new Map<string, OrphanLeafInfo>();
  const addUpdate = (nodeId: string, upd: ProjectSkillUpdate): void => {
    const list = updatesByNode.get(nodeId);
    if (list !== undefined) list.push(upd);
    else updatesByNode.set(nodeId, [upd]);
  };
  // Classify an orphan leaf's badge. Untracked source (removed / git-arrived)
  // with a remote -> unlinked; no remote -> local; tracked repo -> neither.
  const recordOrphan = (leafId: string, entry: LeafEntry): void => {
    if (!trackedIds.has(entry.repoId) && entry.remote !== undefined) {
      orphanLeaves.set(leafId, { kind: 'unlinked', remote: entry.remote });
    } else if (entry.remote === undefined) {
      orphanLeaves.set(leafId, { kind: 'local' });
    }
  };

  const nodes: TreeNode[] = [];
  for (const project of projects) {
    const entries = new Map<string, LeafEntry>();
    const ensure = (repoId: string, group: string | undefined, name: string): LeafEntry => {
      const id = projectSkillKey(project.id, repoId, group, name);
      let e = entries.get(id);
      if (e === undefined) {
        e = { repoId, group, name, available: false, installed: false, agents: [] };
        entries.set(id, e);
      }
      return e;
    };

    for (const s of available) {
      if (!shownRepoIds.has(s.repoId)) continue;
      const e = ensure(s.repoId, s.group, s.name);
      e.available = true;
      e.availableHash = s.contentHash;
      e.remote ??= s.remote;
    }
    for (const m of installs) {
      if (m.target.scope !== 'project' || m.target.projectId !== project.id) continue;
      if (m.sourceRepoId === undefined) continue;
      // Filtered-out tracked repos are hidden; dangling installs always show.
      if (trackedIds.has(m.sourceRepoId) && !shownRepoIds.has(m.sourceRepoId)) continue;
      const e = ensure(m.sourceRepoId, m.skillId.group, m.skillId.name);
      e.installed = true;
      e.installedHash = m.contentHash;
      e.remote ??= m.sourceRemote;
      if (!e.agents.includes(m.target.agent)) e.agents.push(m.target.agent);
    }

    // Group entries by repo, then by group, preserving leaf ids.
    const byRepo = new Map<string, { leafId: string; entry: LeafEntry }[]>();
    for (const [leafId, entry] of entries) {
      const list = byRepo.get(entry.repoId);
      if (list !== undefined) list.push({ leafId, entry });
      else byRepo.set(entry.repoId, [{ leafId, entry }]);
    }

    // The `''` bucket holds unmanaged skills (present in the project but not
    // installed from a tracked repo). They render at the repository level.
    const unmanaged = byRepo.get('') ?? [];
    byRepo.delete('');

    const repoIds = [...byRepo.keys()].sort((a, b) =>
      (repoNameById.get(a) ?? a).localeCompare(repoNameById.get(b) ?? b),
    );
    const repoNodes: TreeNode[] = [];
    for (const repoId of repoIds) {
      const items = byRepo.get(repoId)!;
      const remote = items.find((i) => i.entry.remote !== undefined)?.entry.remote;
      const repoName = repoNameById.get(repoId) ?? repoLabelFromRemote(remote, repoId);
      const repoBranchId = projectRepoNodeId(project.id, repoId);
      // A repo node that is not tracked (removed) is itself "unlinked" -- offer to
      // re-add it (one action re-links all of its skills).
      if (!trackedIds.has(repoId) && remote !== undefined) {
        orphanLeaves.set(repoBranchId, { kind: 'unlinked', remote });
      }

      const makeLeaf = ({ leafId, entry }: { leafId: string; entry: LeafEntry }): TreeNode => {
        const status = leafStatus(entry);
        statusByLeaf.set(leafId, status);
        if (status === 'orphan') recordOrphan(leafId, entry);
        if (status === 'update') {
          const upd: ProjectSkillUpdate = {
            projectId: project.id,
            projectPath: project.path,
            agents: [...entry.agents],
            ref: { repoId, group: entry.group, name: entry.name },
            repoId,
            repoName,
          };
          for (const nid of [leafId, projectGroupNodeId(project.id, repoId, entry.group ?? ''), repoBranchId]) {
            addUpdate(nid, upd);
          }
        }
        return {
          id: leafId,
          label: entry.name,
          icon: skillIcon,
          muted: status === 'orphan',
        };
      };

      const groups = new Map<string, { leafId: string; entry: LeafEntry }[]>();
      const ungrouped: { leafId: string; entry: LeafEntry }[] = [];
      for (const it of items) {
        if (it.entry.group !== undefined && it.entry.group !== '') {
          const list = groups.get(it.entry.group);
          if (list !== undefined) list.push(it);
          else groups.set(it.entry.group, [it]);
        } else ungrouped.push(it);
      }

      const children: TreeNode[] = [];
      for (const [group, gs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const leaves = [...gs].sort((a, b) => a.entry.name.localeCompare(b.entry.name)).map(makeLeaf);
        children.push({
          id: projectGroupNodeId(project.id, repoId, group),
          label: group,
          icon: groupIcon,
          muted: leaves.every((l) => l.muted === true),
          children: leaves,
        });
      }
      for (const it of [...ungrouped].sort((a, b) => a.entry.name.localeCompare(b.entry.name))) {
        children.push(makeLeaf(it));
      }

      repoNodes.push({
        id: repoBranchId,
        label: repoName,
        icon: repoIcon,
        muted: children.every((c) => c.muted === true),
        children,
      });
    }

    // Unmanaged skills: leaves directly under the project (repository level),
    // always orphan (grey, remove-only) since they have no repository source.
    const unmanagedLeaves = [...unmanaged]
      .sort((a, b) => a.entry.name.localeCompare(b.entry.name))
      .map(({ leafId, entry }) => {
        const status = leafStatus(entry);
        statusByLeaf.set(leafId, status);
        if (status === 'orphan') recordOrphan(leafId, entry);
        return { id: leafId, label: entry.name, icon: skillIcon, muted: status === 'orphan' };
      });

    const projectChildren = [...repoNodes, ...unmanagedLeaves];
    nodes.push({
      id: projectNodeId(project.id),
      label: project.name,
      icon: projectIcon,
      selectable: false,
      muted: projectChildren.length > 0 && projectChildren.every((c) => c.muted === true),
      children: projectChildren,
    });
  }

  return { nodes, statusByLeaf, updatesByNode, orphanLeaves };
}

/** Project-mode leaf ids for every currently-installed skill (pre-checked set). */
export function installedLeafIds(installs: readonly InstallManifest[]): string[] {
  const out: string[] = [];
  for (const m of installs) {
    if (m.target.projectId === undefined || m.sourceRepoId === undefined) continue;
    out.push(projectSkillKey(m.target.projectId, m.sourceRepoId, m.skillId.group, m.skillId.name));
  }
  return out;
}

/**
 * Agents each project currently has skills installed for (project id -> agents).
 * The baseline for the project-mode agent picker and the "agents changed" mark.
 */
export function installedAgentsByProject(installs: readonly InstallManifest[]): Record<string, AgentKind[]> {
  const map: Record<string, AgentKind[]> = {};
  for (const m of installs) {
    const pid = m.target.projectId;
    if (m.target.scope !== 'project' || pid === undefined) continue;
    const list = (map[pid] ??= []);
    if (!list.includes(m.target.agent)) list.push(m.target.agent);
  }
  return map;
}

/** Ids of every branch node (for expand-all while searching). */
export function collectBranchIds(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly TreeNode[]): void => {
    for (const n of list) {
      if (n.children !== undefined && n.children.length > 0) {
        out.push(n.id);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Top-level node ids (repos/projects), so the first level opens by default. */
export function rootIds(nodes: readonly TreeNode[]): string[] {
  return nodes.map((n) => n.id);
}

/** Branch ids that have a descendant leaf whose id is in `keys` (ancestors of
 *  the changed leaves), so only those branches need to open. */
export function branchesContaining(nodes: readonly TreeNode[], keys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode): boolean => {
    const kids = node.children;
    if (kids === undefined || kids.length === 0) return keys.has(node.id);
    let any = false;
    for (const child of kids) if (walk(child)) any = true;
    if (any) out.push(node.id);
    return any;
  };
  for (const node of nodes) walk(node);
  return out;
}

/** Number of leaf (skill) nodes in the tree. */
export function countLeaves(nodes: readonly TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.children !== undefined && node.children.length > 0) n += countLeaves(node.children);
    else n += 1;
  }
  return n;
}

/**
 * Keep a node when it (fuzzily) matches or any descendant matches. A matching
 * branch keeps its whole subtree; a non-matching branch keeps only its matching
 * descendants. Ancestors of matches stay as context.
 */
export function filterTree(nodes: readonly TreeNode[], query: string): TreeNode[] {
  if (query.trim() === '') return [...nodes];
  const out: TreeNode[] = [];
  for (const node of nodes) {
    const label = typeof node.label === 'string' ? node.label : '';
    const selfMatch = fuzzyMatches(label, query);
    if (node.children === undefined || node.children.length === 0) {
      if (selfMatch) out.push(node);
      continue;
    }
    if (selfMatch) {
      out.push(node);
      continue;
    }
    const kids = filterTree(node.children, query);
    if (kids.length > 0) out.push({ ...node, children: kids });
  }
  return out;
}
