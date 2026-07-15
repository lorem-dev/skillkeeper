/**
 * Install and remove composed MCP server instances: renders parameters, writes
 * the native agent config, upserts/removes guidance, and keeps both ledger
 * files (`.skmcp.yml`, `.skmcp.params.yml`) in sync. See the design doc "MCP
 * support" section 5 ("Install / update engine") and section 1
 * ("Ownership model", "Ledger files").
 *
 * Core stays pure: callers pass already-resolved absolute paths (native
 * config, ledger, params, guidance files); the main process resolves agent ->
 * path before calling in.
 */
import type { AgentKind } from '../kernel/model.js';
import type { McpServerDef } from './model.js';
import type { FsPort } from '../kernel/ports.js';
import { renderParams } from './params.js';
import { writerFor } from './writers/index.js';
import { allocateInstanceName } from './naming.js';
import { hashMcpDef } from './hashing.js';
import { guidanceKey, stripGuidanceMarkers, upsertGuidanceBlock, removeGuidanceBlock } from '../hooks/guidance.js';
import {
  parseSkmcp,
  serializeSkmcp,
  parseSkmcpParams,
  serializeSkmcpParams,
  SKMCP_SCHEMA,
} from './skmcp.js';
import type { SkmcpEntry } from './skmcp.js';
import { ensureGitignore } from './gitignoreEnsure.js';

/** Identity of an MCP install source, matching a `.skmcp.yml` entry. */
export interface McpIdentity {
  /** Source repository remote URL (absent for manual presets). */
  readonly remote?: string;
  /** Skill-group directory the preset lives in (absent at the repo root). */
  readonly group?: string;
  /** Manual preset id (present only for manual presets). */
  readonly local?: string;
  /** Server name as it appears in `mcp.yml`/the preset. */
  readonly source: string;
}

/** Arguments for {@link installMcpInstance}. */
export interface InstallMcpArgs {
  /** Selects the native writer via `writerFor(agent)`. */
  readonly agent: AgentKind;
  /** Native agent MCP config file. */
  readonly nativePath: string;
  /** `.skmcp.yml` path. */
  readonly ledgerPath: string;
  /** `.skmcp.params.yml` path. */
  readonly paramsPath: string;
  /** Absolute guidance files to receive the rendered `rules` block, if any. */
  readonly guidanceFiles: readonly string[];
  readonly identity: McpIdentity;
  /** The raw server def (placeholders intact). */
  readonly def: McpServerDef;
  /** Parameter values to render into `def`. */
  readonly values: Record<string, string>;
  /**
   * When set, this exact instance name is used verbatim (the allocator is
   * skipped), even if it collides with a name already in the native config.
   * Used by update to reinstall under the SAME name. When absent, a fresh name
   * is allocated as before.
   */
  readonly instanceName?: string;
  /** When set (project scope), `ensureGitignore` is run against this path. */
  readonly gitignoreProjectPath?: string;
}

/** Arguments for {@link removeMcpInstance}. */
export interface RemoveMcpArgs {
  readonly agent: AgentKind;
  readonly nativePath: string;
  readonly ledgerPath: string;
  readonly paramsPath: string;
  readonly guidanceFiles: readonly string[];
  readonly instanceName: string;
}

/** The `.skmcp.yml` guidance identity: `remote`, or `local:<id>` for manual presets. */
function guidanceIdentity(id: { remote?: string; local?: string }): string {
  return id.remote ?? `local:${id.local}`;
}

/**
 * Install one MCP server instance: render its parameters, write the native
 * config, upsert guidance (when the def carries `rules`), and record the
 * install in both ledger files. See the design doc section 5 for the exact
 * sequence.
 */
export async function installMcpInstance(
  fs: FsPort,
  args: InstallMcpArgs,
): Promise<{ instanceName: string }> {
  const rendered = renderParams(args.def, args.values);

  const nativeText = (await fs.exists(args.nativePath)) ? await fs.readFile(args.nativePath) : '';
  const writer = writerFor(args.agent);

  const instanceName =
    args.instanceName ?? allocateInstanceName(args.identity.source, writer.existingNames(nativeText));

  await fs.writeFile(args.nativePath, writer.upsert(nativeText, instanceName, rendered));

  if (args.def.rules !== undefined) {
    const key = guidanceKey(guidanceIdentity(args.identity), instanceName);
    const body = stripGuidanceMarkers(rendered.rules ?? '');
    for (const guidanceFile of args.guidanceFiles) {
      const fileText = (await fs.exists(guidanceFile)) ? await fs.readFile(guidanceFile) : '';
      await fs.writeFile(guidanceFile, upsertGuidanceBlock(fileText, key, body));
    }
  }

  const ledgerText = (await fs.exists(args.ledgerPath)) ? await fs.readFile(args.ledgerPath) : '';
  const ledger = parseSkmcp(ledgerText) ?? { schema: SKMCP_SCHEMA, servers: [] };
  const entry: SkmcpEntry = {
    remote: args.identity.remote,
    group: args.identity.group,
    local: args.identity.local,
    source: args.identity.source,
    name: instanceName,
    hash: hashMcpDef(args.def),
  };
  await fs.writeFile(
    args.ledgerPath,
    serializeSkmcp({ schema: ledger.schema, servers: [...ledger.servers, entry] }),
  );

  const paramsText = (await fs.exists(args.paramsPath)) ? await fs.readFile(args.paramsPath) : '';
  const paramsMap = parseSkmcpParams(paramsText);
  paramsMap[instanceName] = args.values;
  await fs.writeFile(args.paramsPath, serializeSkmcpParams(paramsMap));

  if (args.gitignoreProjectPath !== undefined) {
    await ensureGitignore(fs, args.gitignoreProjectPath);
  }

  return { instanceName };
}

/**
 * Remove one MCP server instance by name: the reverse of
 * {@link installMcpInstance}. No-op safe on each side that has already been
 * dropped (missing native server, missing guidance block, missing ledger
 * entry).
 */
export async function removeMcpInstance(fs: FsPort, args: RemoveMcpArgs): Promise<void> {
  const ledgerText = (await fs.exists(args.ledgerPath)) ? await fs.readFile(args.ledgerPath) : '';
  const ledger = parseSkmcp(ledgerText) ?? { schema: SKMCP_SCHEMA, servers: [] };
  const entry = ledger.servers.find((s) => s.name === args.instanceName);

  const nativeText = (await fs.exists(args.nativePath)) ? await fs.readFile(args.nativePath) : '';
  const writer = writerFor(args.agent);
  await fs.writeFile(args.nativePath, writer.remove(nativeText, args.instanceName));

  if (entry !== undefined) {
    const key = guidanceKey(guidanceIdentity(entry), args.instanceName);
    for (const guidanceFile of args.guidanceFiles) {
      const fileText = (await fs.exists(guidanceFile)) ? await fs.readFile(guidanceFile) : '';
      await fs.writeFile(guidanceFile, removeGuidanceBlock(fileText, key));
    }
  }

  const nextServers = ledger.servers.filter((s) => s.name !== args.instanceName);
  await fs.writeFile(args.ledgerPath, serializeSkmcp({ schema: ledger.schema, servers: nextServers }));

  const paramsText = (await fs.exists(args.paramsPath)) ? await fs.readFile(args.paramsPath) : '';
  const paramsMap = parseSkmcpParams(paramsText);
  delete paramsMap[args.instanceName];
  await fs.writeFile(args.paramsPath, serializeSkmcpParams(paramsMap));
}
