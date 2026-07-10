/**
 * `skillkeeper mcp` command group: list, install, remove, update.
 *
 * MCP server presets come from two origins: repository `mcp.yml`/`mcp.yaml`
 * files (the repo root, no group, plus one per skill-group directory) and
 * manual presets recorded in `config.mcp.servers`. Installing an instance
 * renders `{param}` placeholders and writes the target agent's native MCP
 * config, tracking the install in the `.skmcp.yml` / `.skmcp.params.yml`
 * ledgers that live alongside that agent's skills destination root (the
 * SAME root the skill engine resolves). Codex installs are always global.
 *
 * This module reimplements the small amount of target-resolution logic that
 * `apps/desktop/src/main/mcp.ts` also has (it cannot be imported from a CLI
 * package); both are thin wrappers over the shared core engine
 * (`installMcpInstance`/`removeMcpInstance`/`writerFor`/`mcpDestination`).
 */

import type { Command } from 'commander';
import type {
  FsPort,
  AgentKind,
  AgentTarget,
  AdapterRegistry,
  McpServerDef,
  McpIdentity,
} from '@skillkeeper/core';
import {
  loadState,
  resolveSkills,
  parseMcpConfig,
  McpConfigError,
  hashMcpDef,
  missingParams,
  installMcpInstance,
  removeMcpInstance,
  supportsTransport,
  mcpDestination,
  parseSkmcp,
  parseSkmcpParams,
  normalizeRemote,
  SKMCP_FILE,
  SKMCP_PARAMS_FILE,
} from '@skillkeeper/core';
import type { McpPreset } from '@skillkeeper/config';
import type { Translator } from '@skillkeeper/i18n';
import { PROJECT_DIR_ENV } from '@skillkeeper/agents';
import type { AdapterHostEnv } from '@skillkeeper/agents';

/** The four project-scoped MCP agents; codex is handled separately (global). */
const PROJECT_MCP_AGENTS: readonly AgentKind[] = ['claude', 'cursor', 'copilot', 'opencode'];

interface McpDeps {
  readonly fs: FsPort;
  readonly statePath: string;
  readonly registry: AdapterRegistry;
  readonly adapterEnv: AdapterHostEnv;
  readonly t: Translator;
  /** Manual presets from config.mcp.servers. */
  readonly manualPresets: readonly McpPreset[];
  /**
   * Resolve the current working directory. Injectable so tests can pin it
   * without relying on the test runner's cwd. Defaults to process.cwd in main.
   */
  readonly cwd: () => string;
}

/** One MCP preset available for install: repo-discovered or manual. */
interface McpPresetEntry {
  readonly origin: 'repo' | 'manual';
  readonly def: McpServerDef;
  readonly hash: string;
  /** Repo presets only. */
  readonly remote?: string;
  readonly group?: string;
  /** Manual presets only: the config-assigned preset id. */
  readonly localId?: string;
}

const MCP_FILE_NAMES = ['mcp.yml', 'mcp.yaml'] as const;

/**
 * Read and parse the first mcp.yml/mcp.yaml found directly under `dir`
 * (preferring `mcp.yml`). Returns an empty list when neither file exists, or
 * when the file found fails to parse (reported via `warn`, never thrown).
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
 * Every MCP preset available: repo-discovered (root + skill-group
 * directories, mirroring `listAvailableSkills`/`listAvailableMcp`) plus every
 * manual preset from config. A repo that cannot be resolved is skipped;
 * others still list.
 */
async function listPresets(deps: McpDeps): Promise<McpPresetEntry[]> {
  const out: McpPresetEntry[] = [];
  const warn = (message: string): void => console.warn(`[mcp] ${message}`);
  const state = await loadState(deps.fs, deps.statePath);

  for (const repo of state.repositories) {
    try {
      if (!(await deps.fs.exists(repo.localPath))) continue;
      const push = (group: string | undefined, defs: McpServerDef[]): void => {
        for (const def of defs) {
          out.push({ origin: 'repo', def, hash: hashMcpDef(def), remote: repo.url, group });
        }
      };
      push(undefined, await readMcpDefs(deps.fs, repo.localPath, warn));

      // Group candidates come from the on-disk directory holding each resolved
      // skill, mirroring listAvailableMcp: an mcp.yml sits in the actual
      // directory, not under a skillkeeper.repo.yaml-assigned group label.
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

  for (const preset of deps.manualPresets) {
    const { id, ...def } = preset;
    out.push({ origin: 'manual', def, hash: hashMcpDef(def), localId: id });
  }

  return out;
}

/** Display/match label for a preset: "group/name" when grouped, else "name". */
function presetLabel(p: McpPresetEntry): string {
  return p.group !== undefined ? `${p.group}/${p.def.name}` : p.def.name;
}

/** The `.skmcp.yml` ledger identity for a preset entry. */
function presetIdentity(p: McpPresetEntry): McpIdentity {
  return { remote: p.remote, group: p.group, local: p.localId, source: p.def.name };
}

/**
 * Resolve one preset by exact `def.name` or its `group/name` label.
 *
 * @throws Error when no preset matches, or more than one does (lists the
 *   ambiguous candidates so the caller can disambiguate with `group/name`).
 */
function findPreset(presets: readonly McpPresetEntry[], name: string): McpPresetEntry {
  const matches = presets.filter((p) => p.def.name === name || presetLabel(p) === name);
  if (matches.length === 0) {
    throw new Error(`MCP preset not found: ${name}`);
  }
  if (matches.length > 1) {
    const labels = matches.map((p) => `${presetLabel(p)} (${p.origin})`).join(', ');
    throw new Error(`Ambiguous MCP preset name "${name}"; candidates: ${labels}`);
  }
  return matches[0]!;
}

/** The resolved on-disk locations one MCP install writes to for an agent. */
interface McpTarget {
  /** Native agent MCP config file. */
  readonly nativePath: string;
  /** `.skmcp.yml` under the agent's skills root for this scope. */
  readonly ledgerPath: string;
  /** `.skmcp.params.yml` sibling of the ledger. */
  readonly paramsPath: string;
  /** Per-agent guidance files that skill rules (and MCP rules) install into. */
  readonly guidanceFiles: string[];
}

/**
 * Resolve where one MCP install for `agent` writes: the native config path,
 * the ledger/params paths under the agent's skills destination root (the
 * same root the skill engine resolves), and the agent's guidance file.
 * Codex resolves globally regardless of `args.projectPath`; the other four
 * agents resolve under the project.
 */
async function resolveMcpTarget(
  deps: McpDeps,
  agent: AgentKind,
  args: { readonly projectPath: string; readonly projectId: string },
): Promise<McpTarget> {
  const isCodex = agent === 'codex';
  const target: AgentTarget = isCodex
    ? { agent, scope: 'global' }
    : { agent, scope: 'project', projectId: args.projectId };
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

/** Resolve the project directory: `--project` when given, else cwd. */
function resolveProjectPath(deps: McpDeps, projectOpt: string | undefined): string {
  return projectOpt ?? deps.cwd();
}

/** Parse one `name=value` entry; undefined when malformed (no `=`, or empty name). */
function parseParamEntry(entry: string): readonly [string, string] | undefined {
  const idx = entry.indexOf('=');
  if (idx <= 0) return undefined;
  return [entry.slice(0, idx), entry.slice(idx + 1)];
}

/** Commander accumulator: split a comma-separated / repeatable option into a de-duplicated list. */
function collectCsv(value: string, previous: string[]): string[] {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out = [...previous];
  for (const p of parts) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Commander accumulator for repeatable `--param name=value` entries. */
function collectParam(value: string, previous: Record<string, string>): Record<string, string> {
  const parsed = parseParamEntry(value);
  if (parsed === undefined) {
    console.error(`Invalid --param "${value}"; expected name=value`);
    process.exit(1);
  }
  return { ...previous, [parsed[0]]: parsed[1] };
}

/**
 * True when a `.skmcp.yml` entry's identity matches `preset`: repo entries
 * compare `(normalizeRemote(remote), group, source)`; manual entries compare
 * `(local, source)`.
 */
function identityMatches(
  entry: { readonly remote?: string; readonly group?: string; readonly local?: string; readonly source: string },
  preset: McpPresetEntry,
): boolean {
  if (preset.origin === 'manual') {
    return entry.local !== undefined && entry.local === preset.localId && entry.source === preset.def.name;
  }
  return (
    entry.remote !== undefined &&
    preset.remote !== undefined &&
    normalizeRemote(entry.remote) === normalizeRemote(preset.remote) &&
    entry.group === preset.group &&
    entry.source === preset.def.name
  );
}

export function registerMcpCommands(parent: Command, deps: McpDeps): void {
  const mcp = parent.command('mcp').description('Manage MCP server presets');

  // --- mcp list ---
  mcp
    .command('list')
    .description('List available MCP presets')
    .action(async () => {
      const presets = await listPresets(deps);
      if (presets.length === 0) {
        console.log('No MCP presets available.');
        return;
      }
      for (const p of presets) {
        const source =
          p.origin === 'manual' ? `manual:${p.localId ?? ''}` : (p.remote ?? '(unknown remote)');
        console.log(`${presetLabel(p)}  origin=${p.origin}  type=${p.def.type}  source=${source}`);
      }
    });

  // --- mcp install <name> ---
  mcp
    .command('install <name>')
    .description('Install an MCP preset for one or more agents')
    .option('--project <path>', 'Project directory (default: cwd; ignored for codex, which is global)')
    .option(
      '--agent <agent>',
      'Agent(s) to install for (repeatable or comma-separated)',
      collectCsv,
      [] as string[],
    )
    .option('--param <entry>', 'Parameter value name=value (repeatable)', collectParam, {} as Record<
      string,
      string
    >)
    .action(async (name: string, opts: { project?: string; agent: string[]; param: Record<string, string> }) => {
      const { fs, registry } = deps;
      if (opts.agent.length === 0) {
        console.error('At least one --agent is required.');
        process.exit(1);
      }

      let preset: McpPresetEntry;
      try {
        preset = findPreset(await listPresets(deps), name);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const missing = missingParams(preset.def, opts.param);
      if (missing.length > 0) {
        console.error(`Missing values for mcp params: ${missing.join(', ')}. Pass --param <name>=<value>.`);
        process.exit(1);
      }

      const projectPath = resolveProjectPath(deps, opts.project);
      let anyInstalled = false;

      for (const agentName of opts.agent) {
        const agent = agentName as AgentKind;
        if (!registry.has(agent)) {
          console.error(`Unknown agent: ${agentName}`);
          continue;
        }
        if (!supportsTransport(agent, preset.def.type)) {
          console.log(`Skipped ${agent}: does not support transport "${preset.def.type}".`);
          continue;
        }
        const target = await resolveMcpTarget(deps, agent, { projectPath, projectId: projectPath });
        const { instanceName } = await installMcpInstance(fs, {
          agent,
          nativePath: target.nativePath,
          ledgerPath: target.ledgerPath,
          paramsPath: target.paramsPath,
          guidanceFiles: target.guidanceFiles,
          identity: presetIdentity(preset),
          def: preset.def,
          values: opts.param,
          ...(agent === 'codex' ? {} : { gitignoreProjectPath: projectPath }),
        });
        anyInstalled = true;
        console.log(`Installed: ${instanceName} (${agent}) -> ${target.nativePath}`);
        if (agent === 'codex') {
          console.log('Note: codex MCP servers install globally, not into a project.');
        }
      }

      if (!anyInstalled) process.exit(1);
    });

  // --- mcp remove <instanceName> ---
  mcp
    .command('remove <instanceName>')
    .description('Remove an installed MCP instance')
    .requiredOption('--agent <agent>', 'Agent the instance is installed for')
    .option('--project <path>', 'Project directory (default: cwd; ignored for codex, which is global)')
    .action(async (instanceName: string, opts: { agent: string; project?: string }) => {
      const { fs, registry } = deps;
      const agent = opts.agent as AgentKind;
      if (!registry.has(agent)) {
        console.error(`Unknown agent: ${opts.agent}`);
        process.exit(1);
      }
      const projectPath = resolveProjectPath(deps, opts.project);
      const target = await resolveMcpTarget(deps, agent, { projectPath, projectId: projectPath });

      if (!(await fs.exists(target.ledgerPath))) {
        console.error(`No MCP ledger found for ${agent}.`);
        process.exit(1);
      }
      const ledger = parseSkmcp(await fs.readFile(target.ledgerPath));
      if (ledger === undefined || !ledger.servers.some((s) => s.name === instanceName)) {
        console.error(`MCP instance not found: ${instanceName}`);
        process.exit(1);
      }

      await removeMcpInstance(fs, {
        agent,
        nativePath: target.nativePath,
        ledgerPath: target.ledgerPath,
        paramsPath: target.paramsPath,
        guidanceFiles: target.guidanceFiles,
        instanceName,
      });
      console.log(`Removed: ${instanceName} (${agent})`);
    });

  // --- mcp update [name] ---
  mcp
    .command('update [name]')
    .description('Reinstall MCP instances whose source definition changed')
    .option('--project <path>', 'Project directory (default: cwd); ignored with --all')
    .option(
      '--agent <agent>',
      'Agent(s) to check (repeatable or comma-separated; default: all project agents)',
      collectCsv,
      [] as string[],
    )
    .option('--all', 'Check every tracked project and agent, plus the global codex ledger', false)
    .option(
      '--param <entry>',
      'Value name=value for a newly-required parameter (repeatable)',
      collectParam,
      {} as Record<string, string>,
    )
    .action(
      async (
        name: string | undefined,
        opts: { project?: string; agent: string[]; all: boolean; param: Record<string, string> },
      ) => {
        const { fs, registry } = deps;
        const presets = await listPresets(deps);

        // Resolve the (agent, projectPath, projectId) scopes to check.
        type Scope = { readonly agent: AgentKind; readonly projectPath: string; readonly projectId: string };
        const scopes: Scope[] = [];
        if (opts.all) {
          const state = await loadState(fs, deps.statePath);
          for (const project of state.projects) {
            for (const agent of PROJECT_MCP_AGENTS) {
              scopes.push({ agent, projectPath: project.path, projectId: project.id });
            }
          }
          scopes.push({ agent: 'codex', projectPath: '', projectId: '' });
        } else {
          const projectPath = resolveProjectPath(deps, opts.project);
          const agents: AgentKind[] =
            opts.agent.length > 0 ? (opts.agent as AgentKind[]) : [...PROJECT_MCP_AGENTS];
          for (const agent of agents) {
            scopes.push({ agent, projectPath, projectId: projectPath });
          }
        }

        let updated = 0;
        let failed = false;

        for (const scope of scopes) {
          if (!registry.has(scope.agent)) continue;
          const target = await resolveMcpTarget(deps, scope.agent, scope);
          if (!(await fs.exists(target.ledgerPath))) continue;
          const ledger = parseSkmcp(await fs.readFile(target.ledgerPath));
          if (ledger === undefined) continue;
          const paramsMap = (await fs.exists(target.paramsPath))
            ? parseSkmcpParams(await fs.readFile(target.paramsPath))
            : {};

          for (const entry of ledger.servers) {
            if (name !== undefined && entry.source !== name && `${entry.group ?? ''}/${entry.source}` !== name) {
              continue;
            }
            const current = presets.find((p) => identityMatches(entry, p));
            if (current === undefined) continue; // source no longer available; leave as-is
            if (hashMcpDef(current.def) === entry.hash) continue; // already up to date

            const storedValues = paramsMap[entry.name] ?? {};
            const mergedValues = { ...storedValues, ...opts.param };
            const missing = missingParams(current.def, mergedValues);
            if (missing.length > 0) {
              console.error(
                `Cannot update ${entry.name} (${scope.agent}): missing values for mcp params: ${missing.join(', ')}. Pass --param <name>=<value>.`,
              );
              failed = true;
              continue;
            }

            await removeMcpInstance(fs, {
              agent: scope.agent,
              nativePath: target.nativePath,
              ledgerPath: target.ledgerPath,
              paramsPath: target.paramsPath,
              guidanceFiles: target.guidanceFiles,
              instanceName: entry.name,
            });
            await installMcpInstance(fs, {
              agent: scope.agent,
              nativePath: target.nativePath,
              ledgerPath: target.ledgerPath,
              paramsPath: target.paramsPath,
              guidanceFiles: target.guidanceFiles,
              identity: {
                remote: entry.remote,
                group: entry.group,
                local: entry.local,
                source: entry.source,
              },
              def: current.def,
              values: mergedValues,
              instanceName: entry.name,
              ...(scope.agent === 'codex' ? {} : { gitignoreProjectPath: scope.projectPath }),
            });
            updated += 1;
            console.log(`Updated: ${entry.name} (${scope.agent})`);
          }
        }

        if (updated === 0 && !failed) {
          console.log('No MCP updates available.');
        }
        if (failed) process.exit(1);
      },
    );
}
