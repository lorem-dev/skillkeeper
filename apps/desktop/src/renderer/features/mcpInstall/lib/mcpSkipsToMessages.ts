/**
 * Maps `McpSkipped` entries (see `McpSkipReason` in
 * `apps/desktop/src-tauri/src/commands/mcp.rs`) into localized, deduplicated
 * messages.
 *
 * `reason` exists so the renderer can say WHY an agent was declined rather
 * than only how many were, which is what a bare count did: an oauth skip and
 * a transport skip are different problems with different remedies, and the
 * count told the user neither. The CLI already prints one line per skip
 * naming the rule (`crates/skillkeeper-cli/src/commands/mcp.rs`); this is the
 * desktop's equivalent.
 *
 * Lives beside `installNotesToMessages` and for the same reason: a node-only
 * test cannot reach an async React handler and Storybook cannot show a toast
 * raised from a backend result, so the mapping is only coverable as a pure
 * function. `t` is injected rather than imported so it stays pure.
 */
import type { McpSkipped } from '@/services/bridge';
import type { Translator } from '@/systems/i18n';
import { AGENT_LABELS } from '@/domain';

/**
 * One localized message per distinct skip, deduplicated by rendered text (two
 * presets declined by the same agent for the same rule produce one message)
 * and returned in first-seen order.
 *
 * A transport skip that carries no transport cannot be phrased precisely --
 * the shape allows it even though no current caller produces it -- so those
 * collapse into the one counted message rather than being dropped.
 */
export function mcpSkipsToMessages(skipped: readonly McpSkipped[], t: Translator): string[] {
  const messages = new Set<string>();
  let unnamed = 0;
  for (const skip of skipped) {
    const agent = AGENT_LABELS[skip.agent];
    if (skip.reason === 'oauth') {
      messages.add(t('mcp.oauthUnsupported', { agent }));
      continue;
    }
    if (skip.transport !== undefined) {
      messages.add(
        t('mcp.transportUnsupported', { agent, transport: t(`mcp.protocol.${skip.transport}`) }),
      );
      continue;
    }
    unnamed += 1;
  }
  if (unnamed > 0) messages.add(t('mcp.skippedAgents', { count: String(unnamed) }));
  return [...messages];
}
