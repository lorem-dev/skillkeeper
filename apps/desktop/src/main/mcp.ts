/**
 * MCP preset catalog discovery for the desktop main process, plus per-agent
 * target resolution, install/remove apply, and ledger reading. (Reconcile,
 * pruning, and the update/param-diff flow are a separate task, B2b.)
 *
 * Mirrors `listAvailableSkills` (repositories.ts): for each cloned repository,
 * read the mcp.yml/mcp.yaml declared at the repo root (no group) and inside
 * each skill-group directory (group = the directory name, taken from the
 * distinct groups already resolved by `resolveSkills`), parse each file via
 * `parseMcpConfig`, and flatten every declared server into one `AvailableMcp`.
 *
 * File choice: when a directory has both `mcp.yml` and `mcp.yaml`, `mcp.yml`
 * is read and `mcp.yaml` is ignored entirely (even if `mcp.yml` fails to
 * parse) -- this mirrors the documented precedence, not a fallback chain.
 *
 * A directory's file failing to parse is reported via `console.warn` and
 * skipped; it never fails the rest of the catalog build.
 */
import {
  loadState,
  resolveSkills,
  parseMcpConfig,
  hashMcpDef,
  McpConfigError,
  installMcpInstance,
  removeMcpInstance,
  supportsTransport,
  mcpDestination,
  parseSkmcp,
  parseSkmcpParams,
  SKMCP_FILE,
  SKMCP_PARAMS_FILE,
} from '@skillkeeper/core';
import type {
  AdapterRegistry,
  AgentKind,
  AgentTarget,
  FsPort,
  McpIdentity,
  McpServerDef,
  McpTransport,
} from '@skillkeeper/core';
import { PROJECT_DIR_ENV } from '@skillkeeper/agents';
import type { AdapterHostEnv } from '@skillkeeper/agents';
import { withStateLock } from './stateLock.js';

/** One MCP server preset available from a cloned repository. */
export interface AvailableMcp {
  readonly repoId: string;
  /** Source repository remote URL; the stable identity for matching installs. */
  readonly remote: string;
  /** Optional one-level group (the skill-group directory name); absent for root. */
  readonly group?: string;
  readonly def: McpServerDef;
  /** Content hash of the raw def (excludes `name`), for update detection. */
  readonly hash: string;
}

const MCP_FILE_NAMES = ['mcp.yml', 'mcp.yaml'] as const;

/** The minimal deps this module needs; a subset of the desktop `RepoDeps` shape. */
export interface McpCatalogDeps {
  readonly fs: FsPort;
  readonly statePath: string;
}

/**
 * Read and parse the first mcp.yml/mcp.yaml found directly under `dir`
 * (preferring `mcp.yml`). Returns an empty list when neither file exists, or
 * when the file found fails to parse (a warning is reported via `warn` in
 * that case).
 */
async function readMcpDefs(
  fs: FsPort,
  dir: string,
  warn: (message: string) => void,
): Promise<McpServerDef[]> {
  for (const fileName of MCP_FILE_NAMES) {
    const filePath = `${dir}/${fileName}`;
    if (!(await fs.exists(filePath))) continue;
    try {
      const { servers } = parseMcpConfig(await fs.readFile(filePath));
      return servers;
    } catch (err) {
      const detail = err instanceof McpConfigError ? err.message : String(err);
      warn(`Skipping invalid MCP config at "${filePath}": ${detail}`);
      return [];
    }
  }
  return [];
}

/**
 * Every MCP server preset available across all cloned repositories: a root
 * mcp.yml/mcp.yaml plus one per skill-group directory. Repos whose clone is
 * missing or fails to resolve are skipped, mirroring `listAvailableSkills`.
 */
export async function listAvailableMcp(deps: McpCatalogDeps): Promise<AvailableMcp[]> {
  const out: AvailableMcp[] = [];
  const warn = (message: string): void => {
    console.warn(`[mcp] ${message}`);
  };

  let repos;
  try {
    repos = (await loadState(deps.fs, deps.statePath)).repositories;
  } catch {
    return out;
  }

  for (const repo of repos) {
    try {
      if (!(await deps.fs.exists(repo.localPath))) continue;

      const push = (group: string | undefined, defs: McpServerDef[]): void => {
        for (const def of defs) {
          out.push({ repoId: repo.id, remote: repo.url, group, def, hash: hashMcpDef(def) });
        }
      };

      push(undefined, await readMcpDefs(deps.fs, repo.localPath, warn));

      // Group candidates come from the on-disk directory holding each resolved
      // skill (`rootPath`'s first segment when nested one level), not from the
      // skill's declared `id.group`: a repo using `skillkeeper.repo.yaml` may
      // assign a custom group label decoupled from the directory layout, but an
      // mcp.yml sits in the actual directory, not under that label.
      const { skills } = await resolveSkills(deps.fs, repo.localPath);
      const groups = new Set<string>();
      for (const skill of skills) {
        const parts = skill.rootPath.split('/');
        if (parts.length >= 2) groups.add(parts[0]!);
      }
      for (const group of groups) {
        push(group, await readMcpDefs(deps.fs, `${repo.localPath}/${group}`, warn));
      }
    } catch {
      // Skip a repo that cannot be resolved; others still list.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-agent MCP target resolution + install/remove apply (B2 part 1)
// ---------------------------------------------------------------------------

/**
 * Deps for the apply/list functions: the same shape the skills engine uses,
 * so the main process can hand these functions its existing `SkillsDeps`.
 */
export interface McpDeps {
  readonly fs: FsPort;
  readonly statePath: string;
  readonly registry: AdapterRegistry;
  readonly adapterEnv: AdapterHostEnv;
}

/** The four project-scoped MCP agents; codex is handled separately (global). */
const PROJECT_MCP_AGENTS: readonly AgentKind[] = ['claude', 'cursor', 'copilot', 'opencode'];

/** The resolved on-disk locations one MCP install writes to for an agent. */
export interface McpTarget {
  /** Native agent MCP config file. */
  readonly nativePath: string;
  /** `.skmcp.yml` under the agent's skills root for this scope. */
  readonly ledgerPath: string;
  /** `.skmcp.params.yml` sibling of the ledger. */
  readonly paramsPath: string;
  /** Per-agent guidance files that skill rules install into (MCP rules land here too). */
  readonly guidanceFiles: string[];
}

/**
 * Resolve where one MCP install for `agent` writes: the native config path, the
 * ledger/params paths under the agent's skills destination root (the SAME root
 * the skills engine resolves), and the agent's guidance file(s). Codex resolves
 * globally (its native config, ledger, and guidance all live under the home
 * directory); the other four resolve under the project.
 */
export async function resolveMcpTarget(
  deps: McpDeps,
  agent: AgentKind,
  args: { readonly projectPath: string; readonly projectId: string },
): Promise<McpTarget> {
  const isCodex = agent === 'codex';
  const target: AgentTarget = isCodex
    ? { agent, scope: 'global' }
    : { agent, scope: 'project', projectId: args.projectId };
  // Mirror the skills engine: expose the project directory to the adapters via
  // the environment (AgentTarget only carries a projectId, not a path).
  const env: AdapterHostEnv = {
    ...deps.adapterEnv,
    env: { ...deps.adapterEnv.env, [PROJECT_DIR_ENV]: args.projectPath },
  };
  const nativePath = mcpDestination(agent, {
    projectPath: args.projectPath,
    homeDir: deps.adapterEnv.homeDir,
  }).path;
  const adapter = deps.registry.get(agent);
  const destRoot = await adapter.destinationRoot(target, env);
  const guidanceFile = await adapter.guidanceFile(target, env);
  return {
    nativePath,
    ledgerPath: `${destRoot}/${SKMCP_FILE}`,
    paramsPath: `${destRoot}/${SKMCP_PARAMS_FILE}`,
    guidanceFiles: [guidanceFile],
  };
}

/** One MCP server to install: its source identity, raw def, and param values. */
export interface McpInstallReq {
  readonly identity: McpIdentity;
  readonly def: McpServerDef;
  readonly values: Record<string, string>;
}

/** Install/remove work for one agent within an {@link applyMcp} call. */
export interface McpBatch {
  readonly agent: AgentKind;
  readonly install: readonly McpInstallReq[];
  readonly remove: readonly { readonly instanceName: string }[];
}

/** Arguments for {@link applyMcp}. */
export interface ApplyMcpArgs {
  readonly projectId: string;
  readonly projectPath: string;
  readonly batches: readonly McpBatch[];
}

/** An install skipped because the agent cannot express the def's transport. */
export interface McpSkipped {
  readonly agent: AgentKind;
  readonly source: string;
  readonly transport: McpTransport;
}

/** Result of {@link applyMcp}. Never thrown across the IPC boundary. */
export type ApplyMcpResult =
  | { readonly ok: true; readonly installed: number; readonly removed: number; readonly skipped: McpSkipped[] }
  | { readonly ok: false; readonly error: string };

/**
 * Apply install/remove batches for a project. Removes run before installs (so a
 * re-install onto the same instance name starts clean); an install whose
 * transport the agent cannot express is skipped and reported. Codex batches
 * resolve to the global scope and take no `.gitignore` path. No pruning or
 * update/param-diff logic lives here (that is task B2b).
 */
export async function applyMcp(deps: McpDeps, args: ApplyMcpArgs): Promise<ApplyMcpResult> {
  return withStateLock(async () => {
    try {
      let installed = 0;
      let removed = 0;
      const skipped: McpSkipped[] = [];

      for (const batch of args.batches) {
        const isCodex = batch.agent === 'codex';
        const target = await resolveMcpTarget(deps, batch.agent, {
          projectPath: args.projectPath,
          projectId: args.projectId,
        });

        for (const rem of batch.remove) {
          await removeMcpInstance(deps.fs, {
            agent: batch.agent,
            nativePath: target.nativePath,
            ledgerPath: target.ledgerPath,
            paramsPath: target.paramsPath,
            guidanceFiles: target.guidanceFiles,
            instanceName: rem.instanceName,
          });
          removed += 1;
        }

        for (const ins of batch.install) {
          if (!supportsTransport(batch.agent, ins.def.type)) {
            skipped.push({ agent: batch.agent, source: ins.identity.source, transport: ins.def.type });
            continue;
          }
          await installMcpInstance(deps.fs, {
            agent: batch.agent,
            nativePath: target.nativePath,
            ledgerPath: target.ledgerPath,
            paramsPath: target.paramsPath,
            guidanceFiles: target.guidanceFiles,
            identity: ins.identity,
            def: ins.def,
            values: ins.values,
            ...(isCodex ? {} : { gitignoreProjectPath: args.projectPath }),
          });
          installed += 1;
        }
      }

      return { ok: true, installed, removed, skipped };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** One installed MCP instance recorded in a `.skmcp.yml` ledger. */
export interface McpInstall {
  /** The tracked project's id, or `'global'` for the (codex) global scope. */
  readonly projectId: string | 'global';
  readonly agent: AgentKind;
  readonly instanceName: string;
  readonly identity: {
    readonly remote?: string;
    readonly group?: string;
    readonly local?: string;
    readonly source: string;
  };
  readonly hash: string;
  /** Whether `.skmcp.params.yml` carries an entry for this instance. */
  readonly hasParams: boolean;
}

/**
 * Read every agent's `.skmcp.yml` and map each entry to an {@link McpInstall}:
 * the four project agents across all tracked projects, plus the codex global
 * ledger. Read-only -- no pruning or hash refresh (that is task B2b).
 */
export async function listMcpInstalls(deps: McpDeps): Promise<McpInstall[]> {
  const out: McpInstall[] = [];

  let projects: readonly { readonly id: string; readonly path: string }[];
  try {
    projects = (await loadState(deps.fs, deps.statePath)).projects;
  } catch {
    projects = [];
  }

  const collect = async (
    scopeId: string | 'global',
    agent: AgentKind,
    target: McpTarget,
  ): Promise<void> => {
    if (!(await deps.fs.exists(target.ledgerPath))) return;
    const ledger = parseSkmcp(await deps.fs.readFile(target.ledgerPath));
    if (ledger === undefined) return;
    const params = (await deps.fs.exists(target.paramsPath))
      ? parseSkmcpParams(await deps.fs.readFile(target.paramsPath))
      : {};
    for (const entry of ledger.servers) {
      out.push({
        projectId: scopeId,
        agent,
        instanceName: entry.name,
        identity: {
          ...(entry.remote !== undefined ? { remote: entry.remote } : {}),
          ...(entry.group !== undefined ? { group: entry.group } : {}),
          ...(entry.local !== undefined ? { local: entry.local } : {}),
          source: entry.source,
        },
        hash: entry.hash,
        hasParams: Object.prototype.hasOwnProperty.call(params, entry.name),
      });
    }
  };

  for (const project of projects) {
    for (const agent of PROJECT_MCP_AGENTS) {
      try {
        const target = await resolveMcpTarget(deps, agent, {
          projectPath: project.path,
          projectId: project.id,
        });
        await collect(project.id, agent, target);
      } catch {
        // A project whose target cannot be resolved is skipped; others still list.
      }
    }
  }

  try {
    const codexTarget = await resolveMcpTarget(deps, 'codex', { projectPath: '', projectId: '' });
    await collect('global', 'codex', codexTarget);
  } catch {
    // No codex global ledger resolvable; leave it out.
  }

  return out;
}
