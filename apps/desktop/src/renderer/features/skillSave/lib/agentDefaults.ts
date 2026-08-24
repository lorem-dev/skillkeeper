/**
 * Resolve `AgentChoiceModal`'s per-scope default agent set, plus the two pure
 * helpers it is keyed by. Pure aside from the injected `detect` callback, so it
 * is unit-testable node-only with a fake -- the real caller passes
 * `bridgeClient.detectProjectAgents`, stories and tests pass a fixture-backed
 * fake, since the bridge is unavailable outside Tauri.
 */
import type { AgentKind, InstallManifest, McpInstall, Project } from '@/services/bridge';
import { isGlobalScope } from '@/domain';
import { installedAgentsByProject } from '@/entities/skill';

/**
 * One scope the agent choice covers: its id, plus the tracked project that id
 * names (absent for the reserved global scope, which has no folder of its own).
 */
export interface AgentChoiceScope {
  readonly id: string;
  readonly project?: Project;
}

/**
 * The scopes an agent choice can actually render AND resolve, in the given
 * order. An id matching neither the global scope nor a tracked project is
 * dropped: there is no name to show and no folder to detect.
 *
 * This is the single source of truth for both `AgentChoiceModal`'s rows and
 * `resolveAgentDefaults`' keys -- deriving them separately would let a row be
 * listed with no resolved default, which the modal would then write as an empty
 * agent set, making the save silently inert again (the very bug the agent
 * choice exists to prevent).
 */
export function agentChoiceScopes(scopeIds: readonly string[], projects: readonly Project[]): AgentChoiceScope[] {
  const out: AgentChoiceScope[] = [];
  for (const id of scopeIds) {
    if (isGlobalScope(id)) {
      out.push({ id });
      continue;
    }
    const project = projects.find((p) => p.id === id);
    if (project !== undefined) out.push({ id, project });
  }
  return out;
}

/**
 * Agents each scope already has SOMETHING installed for: skill installs
 * unioned with MCP instances. The chosen agent set drives both plans a save
 * builds (`buildProjectPlan` and `buildProjectMcpPlan`), and both read an agent
 * missing from that set as "remove this agent's copy" -- so a default that
 * omitted an agent with installs would plan a removal the user never asked for.
 *
 * `installedAgentsByProject` covers the skill side; MCP instances need their
 * own pass because `mcpInstalls` is a separate list, keyed by a `projectId`
 * that already carries the reserved global scope id for a user-wide instance.
 */
export function installedAgentsByScope(
  skillInstalls: readonly InstallManifest[],
  mcpInstalls: readonly McpInstall[],
): Record<string, AgentKind[]> {
  const map = installedAgentsByProject(skillInstalls);
  for (const inst of mcpInstalls) {
    const list = (map[inst.projectId] ??= []);
    if (!list.includes(inst.agent)) list.push(inst.agent);
  }
  return map;
}

/**
 * Fold resolved defaults into the choices already on screen, leaving every scope
 * the user has answered themselves (`touched`) untouched.
 *
 * Defaults resolve asynchronously -- a cold file system, network-mounted project
 * paths, or simply several rows can all make detection land well after the modal
 * is usable. Replacing the whole map when it does would revert a pick the user
 * already made, with no explanation and possibly re-disabling Continue.
 */
export function mergeAgentDefaults(
  current: Readonly<Record<string, AgentKind[]>>,
  resolved: Readonly<Record<string, AgentKind[]>>,
  touched: ReadonlySet<string>,
): Record<string, AgentKind[]> {
  const next: Record<string, AgentKind[]> = { ...current };
  for (const [id, agents] of Object.entries(resolved)) {
    if (!touched.has(id)) next[id] = agents;
  }
  return next;
}

/** `first`, then everything in `second` it does not already hold. */
function union(first: readonly AgentKind[], second: readonly AgentKind[]): AgentKind[] {
  const out = [...first];
  for (const agent of second) if (!out.includes(agent)) out.push(agent);
  return out;
}

/**
 * For each scope: the global scope starts from `enabledAgents` (the
 * application's configured agents), a tracked project from whatever
 * `detect(project.path)` finds in its folder. A rejected or an empty detection
 * both contribute nothing -- never surfaced as an error, since a default is
 * only ever a guess for the user to confirm or change.
 *
 * Whatever that guess is, the agents the scope already has installs for
 * (`installedByScope`) are unioned in, so a default can only ever ADD a
 * suggestion, never drop an agent whose skills or MCP servers would then be
 * planned for removal. Detection reads folder markers, which say nothing about
 * what this application installed where.
 */
export async function resolveAgentDefaults(
  scopes: readonly AgentChoiceScope[],
  enabledAgents: readonly AgentKind[],
  installedByScope: Readonly<Record<string, readonly AgentKind[]>>,
  detect: (path: string) => Promise<AgentKind[]>,
): Promise<Record<string, AgentKind[]>> {
  const entries = await Promise.all(
    scopes.map(async (scope): Promise<[string, AgentKind[]]> => {
      const installed = installedByScope[scope.id] ?? [];
      if (scope.project === undefined) return [scope.id, union(enabledAgents, installed)];
      try {
        return [scope.id, union(await detect(scope.project.path), installed)];
      } catch {
        return [scope.id, union([], installed)];
      }
    }),
  );
  return Object.fromEntries(entries);
}
