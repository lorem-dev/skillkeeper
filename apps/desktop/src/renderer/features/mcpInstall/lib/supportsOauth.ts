/**
 * Mirrors the canonical `supports_oauth` in the Rust `skillkeeper-core` crate
 * (`crates/skillkeeper-core/src/mcp/writers.rs`): whether an agent's native
 * MCP config can express a static OAuth client. Every agent except copilot
 * can store one.
 *
 * Reimplemented locally rather than crossing the bridge so it can run
 * synchronously in the install UI (see architecture.md, "In the renderer,
 * import only TYPES"; the same reasoning as `supportsTransport`). The
 * canonical rule is covered by the crate's `cargo test` suite; the two must
 * agree, so change them together.
 */
import type { AgentKind } from '@/services/bridge';

/** Whether `agent` can store a static OAuth client in its native config. */
export function supportsOauth(agent: AgentKind): boolean {
  return agent !== 'copilot';
}
