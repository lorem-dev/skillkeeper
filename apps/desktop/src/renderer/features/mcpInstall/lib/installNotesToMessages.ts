/**
 * Maps `ApplyMcpResult.installed`'s writer notes (`UpsertNote`, see
 * `crates/skillkeeper-core/src/mcp/writers.rs`) into localized, deduplicated
 * messages. Extracted out of `McpInstallModal`'s async `confirm` handler
 * because that mapping otherwise has zero test coverage and no way to gain
 * any: a node-only test cannot reach an async React handler, and Storybook
 * cannot show it either, since the notes surface as toasts raised from a
 * backend result rather than as rendered markup.
 *
 * This is the mechanism that stops a silently dropped auth field from
 * reading to the user as configured -- see `UpsertOutcome`'s doc comment. It
 * must stay pinned by a test, especially since the shape it reads
 * (`ApplyMcpResult.installed`) already changed once on this branch, from a
 * count to an array of per-target records.
 *
 * `t` is injected rather than imported (`useTranslator` requires a React
 * store context) so this stays a pure function, testable with a stub
 * translator.
 */
import type { McpInstalled } from '@/services/bridge';
import type { Translator } from '@/systems/i18n';
import { AGENT_LABELS } from '@/domain';

/**
 * Converts every writer note across `targets` into a localized message,
 * deduplicated by rendered message text (two agents dropping the same field
 * produce one message) and returned in first-seen order.
 */
export function installNotesToMessages(targets: readonly McpInstalled[], t: Translator): string[] {
  const messages = new Set<string>();
  for (const target of targets) {
    for (const note of target.notes) {
      messages.add(
        note.kind === 'droppedField'
          ? t('mcp.oauthFieldDropped', { agent: AGENT_LABELS[target.agent], field: note.field })
          : t('mcp.codexCallbackConflict', { found: String(note.found), wanted: String(note.wanted) }),
      );
    }
  }
  return [...messages];
}
