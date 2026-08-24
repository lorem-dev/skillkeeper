/**
 * Compute a project's apply plan at (skill, agent) granularity, so changing the
 * chosen agent set re-syncs even already-installed skills: the desired state is
 * (checked skills) x (chosen agents); anything installed but not desired is
 * removed, anything desired but not installed is installed. Returns per-agent
 * install/remove lists (ready for `applySkills`) plus per-skill change rows for
 * the review table.
 */
import type { AgentKind, InstallManifest, SkillRef } from '@/services/bridge';
import { scopeIdOf } from '@/domain';
import { parseProjectSkillKey, repoSkillKey } from './skillTree';

export interface AgentOps {
  readonly agent: AgentKind;
  readonly install: SkillRef[];
  readonly remove: SkillRef[];
}

export interface SkillChangeRow {
  readonly skillKey: string;
  readonly ref: SkillRef;
  readonly action: 'install' | 'remove';
  readonly agents: AgentKind[];
}

export interface ProjectPlan {
  readonly projectId: string;
  readonly ops: AgentOps[];
  readonly rows: SkillChangeRow[];
}

const refKey = (ref: SkillRef): string => repoSkillKey(ref.repoId, ref.group, ref.name);

function pushAgent(map: Map<string, AgentKind[]>, key: string, agent: AgentKind): void {
  const list = map.get(key);
  if (list !== undefined) list.push(agent);
  else map.set(key, [agent]);
}

/**
 * Plan for one scope (a tracked project, or the reserved global scope id).
 * `checkedKeys` are project-mode keys (only this scope's are considered);
 * `installs` is the full manifest list.
 */
export function buildProjectPlan(
  projectId: string,
  checkedKeys: readonly string[],
  installs: readonly InstallManifest[],
  chosenAgents: readonly AgentKind[],
): ProjectPlan {
  const refByKey = new Map<string, SkillRef>();
  const wantSet = new Set<string>();
  for (const key of checkedKeys) {
    const p = parseProjectSkillKey(key);
    if (p.projectId !== projectId) continue;
    const ref: SkillRef = { repoId: p.repoId, group: p.group, name: p.name };
    const k = refKey(ref);
    refByKey.set(k, ref);
    wantSet.add(k);
  }

  const installedByAgent = new Map<AgentKind, Set<string>>();
  const installedAgents = new Set<AgentKind>();
  // Keys that may only be removed, never (re)installed for another agent: local
  // skills with no source remote / .skid.yml identity (installed from a working
  // tree) have nowhere to re-install from. Skills that carry a source remote --
  // a tracked repo, or an orphan whose .skid.yml keeps its identity -- can still
  // be installed for other agents.
  const removeOnly = new Set<string>();
  for (const m of installs) {
    // `scopeIdOf` is the single source of truth for which scope bucket an
    // install belongs to (the reserved global id, or the project's own id) --
    // matching on `target.scope` alone would silently drop every global-scope
    // manifest from a `projectId === GLOBAL_SCOPE_ID` plan.
    if (scopeIdOf(m.target) !== projectId) continue;
    if (m.sourceRepoId === undefined) continue;
    const ref: SkillRef = { repoId: m.sourceRepoId, group: m.skillId.group, name: m.skillId.name };
    const k = refKey(ref);
    refByKey.set(k, ref);
    if (m.sourceRemote === undefined) removeOnly.add(k);
    installedAgents.add(m.target.agent);
    const set = installedByAgent.get(m.target.agent) ?? new Set<string>();
    set.add(k);
    installedByAgent.set(m.target.agent, set);
  }

  const chosen = new Set(chosenAgents);
  const allAgents = new Set<AgentKind>([...chosenAgents, ...installedAgents]);

  const ops: AgentOps[] = [];
  const installAgentsByKey = new Map<string, AgentKind[]>();
  const removeAgentsByKey = new Map<string, AgentKind[]>();

  for (const agent of allAgents) {
    const have = installedByAgent.get(agent) ?? new Set<string>();
    const want = chosen.has(agent) ? wantSet : new Set<string>();
    const install: SkillRef[] = [];
    const remove: SkillRef[] = [];
    for (const k of want) {
      // Local (remove-only) skills are never installed for another agent, even
      // when checked; only their removal is planned.
      if (!have.has(k) && !removeOnly.has(k)) {
        install.push(refByKey.get(k)!);
        pushAgent(installAgentsByKey, k, agent);
      }
    }
    for (const k of have) {
      if (!want.has(k)) {
        remove.push(refByKey.get(k)!);
        pushAgent(removeAgentsByKey, k, agent);
      }
    }
    if (install.length > 0 || remove.length > 0) ops.push({ agent, install, remove });
  }

  const rows: SkillChangeRow[] = [];
  for (const [key, agents] of installAgentsByKey) {
    rows.push({ skillKey: key, ref: refByKey.get(key)!, action: 'install', agents });
  }
  for (const [key, agents] of removeAgentsByKey) {
    rows.push({ skillKey: key, ref: refByKey.get(key)!, action: 'remove', agents });
  }
  return { projectId, ops, rows };
}

/**
 * Scope ids whose checked skills would install nothing because no agent is
 * chosen: at least one checked leaf is not installed, and the agent set is
 * empty. Returned in the order of `scopeIds`, so the caller's own scope order
 * (global first, then projects) carries through to the interface.
 *
 * A scope whose only pending change is a removal is deliberately NOT listed: an
 * empty agent set there is a "remove everything" plan, which already produces
 * real operations and a correct review.
 */
export function scopesNeedingAgents(
  scopeIds: readonly string[],
  checkedIds: readonly string[],
  installedIds: readonly string[],
  agentsByScope: Readonly<Record<string, readonly AgentKind[]>>,
): string[] {
  const installed = new Set(installedIds);
  const wouldInstall = new Set<string>();
  for (const key of checkedIds) {
    if (installed.has(key)) continue;
    wouldInstall.add(parseProjectSkillKey(key).projectId);
  }
  return scopeIds.filter((id) => wouldInstall.has(id) && (agentsByScope[id]?.length ?? 0) === 0);
}
