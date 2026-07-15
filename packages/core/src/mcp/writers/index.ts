/**
 * Native MCP config writer registry: one `McpConfigWriter` per agent, plus
 * transport gating and destination-path resolution. See the per-agent
 * mapping table in the design doc (MCP support, section 4).
 */
import type { AgentKind } from '../model.js';
import type { McpTransport } from '../mcpModel.js';
import { createJsonWriter, toOpencodeServerJson, toStandardServerJson } from './jsonWriter.js';
import { createCodexTomlWriter } from './tomlWriter.js';
import type { McpConfigWriter } from './types.js';

export type { McpConfigWriter } from './types.js';

/** The `McpConfigWriter` for `agent`'s native MCP config format. */
export function writerFor(agent: AgentKind): McpConfigWriter {
  switch (agent) {
    case 'claude':
      return createJsonWriter('mcpServers', toStandardServerJson);
    case 'cursor':
      return createJsonWriter('mcpServers', toStandardServerJson);
    case 'copilot':
      return createJsonWriter('servers', toStandardServerJson);
    case 'opencode':
      return createJsonWriter('mcp', toOpencodeServerJson);
    case 'codex':
      return createCodexTomlWriter();
  }
}

/** Whether `agent`'s native config can express transport `t`. Codex is stdio-only. */
export function supportsTransport(agent: AgentKind, t: McpTransport): boolean {
  if (agent === 'codex') return t === 'stdio';
  return true;
}

/** Inputs needed to resolve an agent's native MCP config destination. */
export interface McpDestinationTarget {
  /** Project root; required for every agent except codex (global). */
  readonly projectPath?: string;
  /** User home directory; required for codex only. */
  readonly homeDir?: string;
}

/** Resolved native MCP config file location. */
export interface McpDestination {
  readonly path: string;
  readonly scope: 'project' | 'global';
}

/**
 * Resolve where `agent` keeps its native MCP config. Project-scoped agents
 * resolve under `target.projectPath`; codex is global, under
 * `target.homeDir`.
 *
 * @throws Error when the required target field is missing.
 */
export function mcpDestination(agent: AgentKind, target: McpDestinationTarget): McpDestination {
  if (agent === 'codex') {
    if (target.homeDir === undefined) {
      throw new Error('codex destination requires "homeDir"');
    }
    return { path: `${target.homeDir}/.codex/config.toml`, scope: 'global' };
  }
  if (target.projectPath === undefined) {
    throw new Error(`${agent} destination requires "projectPath"`);
  }
  switch (agent) {
    case 'claude':
      return { path: `${target.projectPath}/.mcp.json`, scope: 'project' };
    case 'cursor':
      return { path: `${target.projectPath}/.cursor/mcp.json`, scope: 'project' };
    case 'copilot':
      return { path: `${target.projectPath}/.vscode/mcp.json`, scope: 'project' };
    case 'opencode':
      return { path: `${target.projectPath}/opencode.json`, scope: 'project' };
  }
}
