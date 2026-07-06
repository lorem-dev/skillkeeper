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
import type { AvailableSkill, InstallManifest, Repository, Project } from '@/services/bridge';

const SEP = '::';

const repoIcon = <Icon name="repositories" size={18} />;
const groupIcon = <Icon name="skill-group" size={18} />;
const skillIcon = <Icon name="skills" size={18} />;
const projectIcon = <Icon name="projects" size={18} />;

/** Stable checkbox key for a repo-mode skill leaf. */
export function repoSkillKey(repoId: string, group: string | undefined, name: string): string {
  return [repoId, group ?? '', name].join(SEP);
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
        id: `${repo.id}${SEP}${group}`,
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

    nodes.push({ id: `repo${SEP}${repo.id}`, label: repo.name, icon: repoIcon, selectable: false, children });
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
          id: `${project.id}${SEP}${repo.id}${SEP}${group}`,
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

      repoNodes.push({ id: `${project.id}${SEP}repo${SEP}${repo.id}`, label: repo.name, icon: repoIcon, children });
    }
    nodes.push({ id: `proj${SEP}${project.id}`, label: project.name, icon: projectIcon, selectable: false, children: repoNodes });
  }
  return nodes;
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
