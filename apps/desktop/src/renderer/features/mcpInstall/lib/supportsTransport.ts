/**
 * Mirrors core's `supportsTransport` (`packages/core/src/mcpWriters/index.ts`):
 * whether an agent's native MCP config can express a given transport. Codex
 * writes TOML `[mcp_servers.*]` entries that only support stdio; every other
 * agent's JSON config can express all three transports.
 *
 * Duplicated locally rather than imported from `@skillkeeper/core` because the
 * renderer must not pull core's runtime module graph into the sandboxed
 * bundle (see architecture.md, "In the renderer, import only TYPES"; the same
 * reasoning as the store's `scanMcpParams`/`normalizeMcpRemote`/
 * `hashMcpDefInRenderer`). `supportsTransport.test.ts` pins this against
 * core's original for every (agent, transport) pair so the two cannot drift.
 */
import type { AgentKind, McpTransport } from '@/services/bridge';

export function supportsTransport(agent: AgentKind, transport: McpTransport): boolean {
  if (agent === 'codex') return transport === 'stdio';
  return true;
}
