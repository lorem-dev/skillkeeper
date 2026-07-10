/**
 * MCP counterpart of `entities/skill/lib/applyPlan.ts`'s `buildProjectPlan`:
 * computes the MCP-instance rows for the skills-change (agent-set-change)
 * review modal (design spec "MCP support" section 8, "Skills-change modal
 * (agent changes)"). For each DISTINCT installed MCP instance-source in the
 * project (grouped by identity across agents), an agent ADDED to the chosen
 * set that does not yet have the instance yields an "install" row; an agent
 * REMOVED from the chosen set that has it yields a "remove" row. Only agents
 * whose native config can express the instance's transport are install
 * candidates (`supportsTransport`, reused from `features/mcpInstall/lib`).
 *
 * This lives in `features/skillSave/lib` rather than beside `applyPlan.ts`
 * (`entities/skill/lib`) because it needs `McpPreset` from `@/app/store`, and
 * `entities` may not import from `app` (architecture.md's import boundaries) --
 * the same reasoning that put the Skills-page MCP tree-merge helpers in
 * `pages/Skills/lib` rather than `entities/skill/lib` (task C7).
 *
 * Parameter values are never read back from disk into the renderer (the
 * renderer only ever learns whether an instance HAS params via
 * `McpInstall.hasParams`, never their content -- they may hold secrets). When
 * a to-install instance's preset requires params and an already-installed
 * sibling agent has them stored, the install request carries a
 * `copyParamsFrom` hint instead of values; the main process resolves it
 * against that sibling's own `.skmcp.params.yml` at apply time (see
 * `resolveInstallValues` in `apps/desktop/src/main/mcp.ts`). When no sibling
 * has stored params yet (should not happen for an existing instance, per the
 * design spec), the row is flagged `needsParamPrompt` and carries no batch
 * entry -- the caller must collect values (e.g. via a param prompt) and build
 * that install itself (`buildInstallBatches`) before applying.
 */
import type { AgentKind, McpBatch, McpIdentity, McpInstall, McpInstallReq } from '@/services/bridge';
import type { McpPreset } from '@/app/store';
import { normalizeMcpRemote } from '@/app/store';
import { supportsTransport } from '@/features/mcpInstall';

/** The four project-scoped MCP agents; codex is global-only and never appears
 *  in a project's `McpInstall` list (mirrors main's `PROJECT_MCP_AGENTS` and
 *  the same exclusion `pages/Skills/lib/mcpTree.tsx` documents for task C7). */
const PROJECT_MCP_AGENTS: readonly AgentKind[] = ['claude', 'cursor', 'copilot', 'opencode'];

export interface McpChangeRow {
  /** Unique within a plan; `install:<identityKey>` or `remove:<identityKey>`. */
  readonly key: string;
  readonly identity: McpIdentity;
  /** The matched preset's name, or the raw source when no preset matches. */
  readonly label: string;
  readonly action: 'install' | 'remove';
  readonly agents: AgentKind[];
  /** Install rows only: true when the preset requires params that no
   *  already-installed sibling agent has stored -- the caller must prompt for
   *  them (this row carries no corresponding `batches` entry). Always false
   *  for remove rows. */
  readonly needsParamPrompt: boolean;
  /** Install rows only: the matched preset, so a caller resolving
   *  `needsParamPrompt` can build the extra install itself. */
  readonly preset?: McpPreset;
}

export interface McpProjectPlan {
  readonly projectId: string;
  readonly rows: McpChangeRow[];
  /** Ready to apply via `applyMcp` -- excludes any agent/identity pair whose
   *  row has `needsParamPrompt: true`. */
  readonly batches: McpBatch[];
}

/** Groups installs sharing the same source across agents (mirrors
 *  `pages/Skills/lib/mcpTree.tsx`'s private `identityKey`). */
function identityKey(identity: McpInstall['identity']): string {
  if (identity.local !== undefined) return `local:${identity.local}`;
  return `remote:${normalizeMcpRemote(identity.remote ?? '')}|${identity.group ?? ''}|${identity.source}`;
}

/** Whether an installed instance's identity matches a preset (manual or
 *  repo-origin); mirrors `identityFor` in `features/mcpInstall/lib/buildBatches.ts`. */
function identityMatchesPreset(identity: McpInstall['identity'], preset: McpPreset): boolean {
  if (preset.origin === 'manual') {
    return identity.local !== undefined && identity.local === preset.id && identity.source === preset.name;
  }
  return (
    identity.remote !== undefined &&
    preset.remote !== undefined &&
    normalizeMcpRemote(identity.remote) === normalizeMcpRemote(preset.remote) &&
    (identity.group ?? undefined) === preset.group &&
    identity.source === preset.name
  );
}

/**
 * Plan for one project's MCP instances given its chosen agent set. `installs`
 * is the full cross-project/cross-scope list (filtered here to `projectId`);
 * `presets` is the full preset catalog (manual + repo-discovered).
 */
export function buildProjectMcpPlan(
  installs: readonly McpInstall[],
  projectId: string,
  chosenAgents: readonly AgentKind[],
  presets: readonly McpPreset[],
): McpProjectPlan {
  const chosen = new Set(chosenAgents);
  const projectInstalls = installs.filter((i) => i.projectId === projectId);

  const groups = new Map<string, McpInstall[]>();
  for (const inst of projectInstalls) {
    const key = identityKey(inst.identity);
    const list = groups.get(key);
    if (list !== undefined) list.push(inst);
    else groups.set(key, [inst]);
  }

  const rows: McpChangeRow[] = [];
  const installByAgent = new Map<AgentKind, McpInstallReq[]>();
  const removeByAgent = new Map<AgentKind, { instanceName: string }[]>();

  for (const [key, insts] of groups) {
    const first = insts[0]!;
    const installedAgents = new Set(insts.map((i) => i.agent));
    const preset = presets.find((p) => identityMatchesPreset(first.identity, p));
    const label = preset?.name ?? first.identity.source;

    const removeAgents = [...installedAgents].filter((a) => !chosen.has(a));
    if (removeAgents.length > 0) {
      for (const agent of removeAgents) {
        const inst = insts.find((i) => i.agent === agent)!;
        const list = removeByAgent.get(agent) ?? [];
        list.push({ instanceName: inst.instanceName });
        removeByAgent.set(agent, list);
      }
      rows.push({
        key: `remove:${key}`,
        identity: first.identity,
        label,
        action: 'remove',
        agents: removeAgents,
        needsParamPrompt: false,
      });
    }

    // No matching preset (its source repo was untracked, or a manual preset
    // was deleted) -- there is no def to install from, so this identity is
    // remove-only, mirroring `applyPlan.ts`'s treatment of local skills.
    if (preset === undefined) continue;

    const addAgents = PROJECT_MCP_AGENTS.filter(
      (agent) => chosen.has(agent) && !installedAgents.has(agent) && supportsTransport(agent, preset.def.type),
    );
    if (addAgents.length === 0) continue;

    const requiresParams = preset.params.length > 0;
    const copySource = requiresParams ? insts.find((i) => i.hasParams) : undefined;
    const needsParamPrompt = requiresParams && copySource === undefined;

    if (!needsParamPrompt) {
      for (const agent of addAgents) {
        const list = installByAgent.get(agent) ?? [];
        list.push({
          identity: first.identity,
          def: preset.def,
          values: {},
          ...(copySource !== undefined
            ? { copyParamsFrom: { agent: copySource.agent, instanceName: copySource.instanceName } }
            : {}),
        });
        installByAgent.set(agent, list);
      }
    }

    rows.push({
      key: `install:${key}`,
      identity: first.identity,
      label,
      action: 'install',
      agents: addAgents,
      needsParamPrompt,
      preset,
    });
  }

  const agents = new Set<AgentKind>([...installByAgent.keys(), ...removeByAgent.keys()]);
  const batches: McpBatch[] = [...agents].map((agent) => ({
    agent,
    install: installByAgent.get(agent) ?? [],
    remove: removeByAgent.get(agent) ?? [],
  }));

  return { projectId, rows, batches };
}
