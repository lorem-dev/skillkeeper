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
  missingParams,
  parseSkmcp,
  parseSkmcpParams,
  serializeSkmcp,
  serializeSkmcpParams,
  writerFor,
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
  /**
   * When set, `values` is ignored and the actual values are read from another
   * agent's already-installed instance of the SAME identity instead (its
   * `.skmcp.params.yml` entry for `instanceName`). Used by the skills-change
   * modal (design spec "MCP support" section 8) to add an agent to an
   * already-installed MCP instance without ever sending stored parameter
   * values (which may hold secrets) back out to the renderer: the renderer
   * only ever knows an instance HAS params (`McpInstall.hasParams`), never
   * their content, so the copy has to happen here, main-process side. Falls
   * back to `values` if the source cannot be read (e.g. removed concurrently).
   */
  readonly copyParamsFrom?: { readonly agent: AgentKind; readonly instanceName: string };
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
 * Resolve the values to render for one install request: `ins.values` as given,
 * unless `ins.copyParamsFrom` names another agent's already-installed instance
 * of the same identity, in which case its stored `.skmcp.params.yml` entry is
 * read and used instead (falling back to `ins.values` if that agent's params
 * file or entry cannot be found, e.g. removed concurrently).
 */
async function resolveInstallValues(
  deps: McpDeps,
  args: ApplyMcpArgs,
  ins: McpInstallReq,
): Promise<Record<string, string>> {
  if (ins.copyParamsFrom === undefined) return ins.values;
  try {
    const sourceTarget = await resolveMcpTarget(deps, ins.copyParamsFrom.agent, {
      projectPath: args.projectPath,
      projectId: args.projectId,
    });
    if (!(await deps.fs.exists(sourceTarget.paramsPath))) return ins.values;
    const sourceParams = parseSkmcpParams(await deps.fs.readFile(sourceTarget.paramsPath));
    const copied = sourceParams[ins.copyParamsFrom.instanceName];
    return copied ?? ins.values;
  } catch {
    return ins.values;
  }
}

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
          const values = await resolveInstallValues(deps, args, ins);
          await installMcpInstance(deps.fs, {
            agent: batch.agent,
            nativePath: target.nativePath,
            ledgerPath: target.ledgerPath,
            paramsPath: target.paramsPath,
            guidanceFiles: target.guidanceFiles,
            identity: ins.identity,
            def: ins.def,
            values,
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

/** Map one ledger entry to an {@link McpInstall} for the given scope/agent. */
function entryToInstall(
  scopeId: string | 'global',
  agent: AgentKind,
  entry: {
    readonly remote?: string;
    readonly group?: string;
    readonly local?: string;
    readonly source: string;
    readonly name: string;
    readonly hash: string;
  },
  hasParams: boolean,
): McpInstall {
  return {
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
    hasParams,
  };
}

/**
 * Reconcile every agent's `.skmcp.yml` with its native MCP config: PRUNE-ONLY.
 * For each ledger entry, read the native config via the agent's writer and drop
 * the ledger + params entry when the native server named by that entry no
 * longer exists. Unknown native servers are never adopted and recorded hashes
 * are never rewritten. An all-present ledger is left byte-for-byte untouched; a
 * ledger with everything pruned is left in place with an empty `servers` list.
 * Returns the surviving install list (mirrors {@link listMcpInstalls}).
 *
 * Called at the same lifecycle points as the skills reconcile (after loadAll,
 * syncRepository, addProject).
 */
export async function reconcileMcp(deps: McpDeps): Promise<McpInstall[]> {
  return withStateLock(async () => {
    const out: McpInstall[] = [];

    let projects: readonly { readonly id: string; readonly path: string }[];
    try {
      projects = (await loadState(deps.fs, deps.statePath)).projects;
    } catch {
      projects = [];
    }

    const reconcileLedger = async (
      scopeId: string | 'global',
      agent: AgentKind,
      target: McpTarget,
    ): Promise<void> => {
      if (!(await deps.fs.exists(target.ledgerPath))) return;
      const ledger = parseSkmcp(await deps.fs.readFile(target.ledgerPath));
      if (ledger === undefined) return;

      const nativeText = (await deps.fs.exists(target.nativePath))
        ? await deps.fs.readFile(target.nativePath)
        : '';
      const present = new Set(writerFor(agent).existingNames(nativeText));

      const kept = ledger.servers.filter((s) => present.has(s.name));
      const pruned = kept.length !== ledger.servers.length;

      if (pruned) {
        await deps.fs.writeFile(
          target.ledgerPath,
          serializeSkmcp({ schema: ledger.schema, servers: kept }),
        );
        // Drop param entries for the pruned names; only rewrite when a key was
        // actually removed (never create an empty params file needlessly).
        if (await deps.fs.exists(target.paramsPath)) {
          const params = parseSkmcpParams(await deps.fs.readFile(target.paramsPath));
          const keptNames = new Set(kept.map((s) => s.name));
          let paramsChanged = false;
          for (const name of Object.keys(params)) {
            if (!keptNames.has(name)) {
              delete params[name];
              paramsChanged = true;
            }
          }
          if (paramsChanged) {
            await deps.fs.writeFile(target.paramsPath, serializeSkmcpParams(params));
          }
        }
      }

      const params = (await deps.fs.exists(target.paramsPath))
        ? parseSkmcpParams(await deps.fs.readFile(target.paramsPath))
        : {};
      for (const entry of kept) {
        out.push(
          entryToInstall(
            scopeId,
            agent,
            entry,
            Object.prototype.hasOwnProperty.call(params, entry.name),
          ),
        );
      }
    };

    for (const project of projects) {
      for (const agent of PROJECT_MCP_AGENTS) {
        try {
          const target = await resolveMcpTarget(deps, agent, {
            projectPath: project.path,
            projectId: project.id,
          });
          await reconcileLedger(project.id, agent, target);
        } catch {
          // A project whose target cannot be resolved is skipped; others still reconcile.
        }
      }
    }

    try {
      const codexTarget = await resolveMcpTarget(deps, 'codex', { projectPath: '', projectId: '' });
      await reconcileLedger('global', 'codex', codexTarget);
    } catch {
      // No codex global ledger resolvable; leave it out.
    }

    return out;
  });
}

/** One MCP instance to update: the new raw def + merged param values, same name. */
export interface McpUpdateReq {
  readonly projectId: string;
  readonly projectPath: string;
  readonly agent: AgentKind;
  /** The existing instance name; the reinstall reuses it verbatim. */
  readonly instanceName: string;
  readonly identity: McpIdentity;
  /** The NEW raw def from the current source (placeholders intact). */
  readonly def: McpServerDef;
  /** Merged param values (the caller has already collected any newly-required params). */
  readonly values: Record<string, string>;
}

/** Arguments for {@link updateMcp}. */
export interface UpdateMcpArgs {
  readonly updates: readonly McpUpdateReq[];
}

/** Result of {@link updateMcp}. Never thrown across the IPC boundary. */
export type UpdateMcpResult =
  | { readonly ok: true; readonly updated: number }
  | { readonly ok: false; readonly error: string };

/**
 * Read an instance's stored param values from its own `.skmcp.params.yml`
 * entry (empty when the file or the entry is absent). Used by both
 * {@link updateMcp} and {@link mcpUpdatePreflight} so an update never needs the
 * renderer to resend values it already has stored -- only newly-required ones.
 */
async function readStoredParams(
  deps: McpDeps,
  target: McpTarget,
  instanceName: string,
): Promise<Record<string, string> | undefined> {
  if (!(await deps.fs.exists(target.paramsPath))) return undefined;
  const params = parseSkmcpParams(await deps.fs.readFile(target.paramsPath));
  return params[instanceName];
}

/** Arguments for {@link mcpUpdatePreflight}. */
export interface McpUpdatePreflightArgs {
  readonly projectId: string;
  readonly projectPath: string;
  readonly agent: AgentKind;
  /** The existing instance name to check stored params against. */
  readonly instanceName: string;
  /** The NEW/current source def (placeholders intact) to check params for. */
  readonly def: McpServerDef;
}

/** Result of {@link mcpUpdatePreflight}. Never thrown across the IPC boundary. */
export type McpUpdatePreflightResult =
  | { readonly ok: true; readonly missingParams: string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Ahead of an update, compute which of the new def's `{param}` placeholders
 * are absent from the instance's OWN stored `.skmcp.params.yml` entry -- the
 * only params the renderer needs to prompt for. The renderer never receives
 * the stored values themselves, only these missing names (see `McpInstall`'s
 * `hasParams` for the same non-disclosure rule on the install/list side).
 */
export async function mcpUpdatePreflight(
  deps: McpDeps,
  args: McpUpdatePreflightArgs,
): Promise<McpUpdatePreflightResult> {
  try {
    const target = await resolveMcpTarget(deps, args.agent, {
      projectPath: args.projectPath,
      projectId: args.projectId,
    });
    const stored = await readStoredParams(deps, target, args.instanceName);
    return { ok: true, missingParams: missingParams(args.def, stored) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Update installed MCP instances in place: for each, remove the old instance
 * and reinstall under the SAME instance name with the NEW def. Param values
 * are resolved server-side: the instance's OWN stored `.skmcp.params.yml`
 * values are read first, then any renderer-supplied `values` are merged on
 * top -- the renderer only ever supplies newly-required params it just
 * collected via {@link mcpUpdatePreflight} (or nothing when there were none),
 * never the instance's existing values. The reinstall refreshes the ledger
 * hash to the new def's hash automatically.
 */
export async function updateMcp(deps: McpDeps, args: UpdateMcpArgs): Promise<UpdateMcpResult> {
  return withStateLock(async () => {
    try {
      let updated = 0;
      for (const u of args.updates) {
        const isCodex = u.agent === 'codex';
        const target = await resolveMcpTarget(deps, u.agent, {
          projectPath: u.projectPath,
          projectId: u.projectId,
        });
        const stored = await readStoredParams(deps, target, u.instanceName);
        const values = { ...stored, ...u.values };
        await removeMcpInstance(deps.fs, {
          agent: u.agent,
          nativePath: target.nativePath,
          ledgerPath: target.ledgerPath,
          paramsPath: target.paramsPath,
          guidanceFiles: target.guidanceFiles,
          instanceName: u.instanceName,
        });
        await installMcpInstance(deps.fs, {
          agent: u.agent,
          nativePath: target.nativePath,
          ledgerPath: target.ledgerPath,
          paramsPath: target.paramsPath,
          guidanceFiles: target.guidanceFiles,
          identity: u.identity,
          def: u.def,
          values,
          instanceName: u.instanceName,
          ...(isCodex ? {} : { gitignoreProjectPath: u.projectPath }),
        });
        updated += 1;
      }
      return { ok: true, updated };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
