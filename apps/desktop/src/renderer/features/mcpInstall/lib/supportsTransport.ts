/**
 * Mirrors the canonical `supports_transport` in the Rust `skillkeeper-core`
 * crate: whether an agent's native MCP config can express a given transport.
 * Codex writes TOML `[mcp_servers.*]` entries that support stdio and http;
 * `sse` support is unverified, so Codex still rejects it. Every other
 * agent's JSON config can express all three transports.
 *
 * Reimplemented locally rather than crossing the bridge so it can run
 * synchronously in the install UI (see architecture.md, "In the renderer,
 * import only TYPES"; the same reasoning as the store's `scanMcpParams`/
 * `normalizeMcpRemote`/`hashMcpDefInRenderer`). The canonical rule is covered
 * by the crate's `cargo test` suite.
 */
import type { AgentKind, McpTransport } from '@/services/bridge';

export function supportsTransport(agent: AgentKind, transport: McpTransport): boolean {
  if (agent === 'codex') return transport !== 'sse';
  return true;
}
