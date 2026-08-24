/**
 * Pure helpers for feeding `McpInstallModal`'s descriptions through the
 * backend's `mcp_description_spans` command in a single batched call: the
 * server's own description first, then each parameter's description in
 * `preset.params` order. That command returns spans in the same order its
 * input arrived in (order in equals order out -- pinned by the command's own
 * test), so `spansForServer`/`spansForParam` read the result back by that
 * same fixed position rather than re-deriving it.
 *
 * A missing description (server or parameter) still gets a slot ('') in the
 * query list so every position lines up, but `spansForServer`/`spansForParam`
 * report `undefined` for it regardless of what the backend parses an empty
 * string into: "no description was authored" and "an empty description" must
 * both render as nothing, not as two different empty states.
 */
import type { McpPreset } from '@/app/store';
import type { DescriptionSpan } from '@/services/bridge';

/** The ordered description strings to send to `mcp_description_spans`. */
export function descriptionQueries(preset: McpPreset): string[] {
  return [
    preset.def.description ?? '',
    ...preset.params.map((param) => preset.def.parameters[param]?.description ?? ''),
  ];
}

/** `undefined` unless `spans` is a non-empty result: the shared "nothing to
 *  render" gate for both helpers below, so an authored-but-empty (`""`)
 *  description -- which parses to `[]`, not to a missing entry -- renders
 *  exactly like no description at all, per this module's own contract. */
function nonEmpty(spans: DescriptionSpan[] | undefined): DescriptionSpan[] | undefined {
  return spans !== undefined && spans.length > 0 ? spans : undefined;
}

/** The server description's spans, or undefined when it has none (or an
 *  empty one). */
export function spansForServer(
  preset: McpPreset,
  results: readonly DescriptionSpan[][],
): DescriptionSpan[] | undefined {
  if (preset.def.description === undefined) return undefined;
  return nonEmpty(results[0]);
}

/**
 * One parameter's description spans, or undefined when it has none (or an
 * empty one). `param`'s position in `preset.params` is what locates the
 * matching entry in `results` (index 0 is always the server description) --
 * NOT its position in `preset.def.parameters`, whose key order can diverge
 * (stale authoring metadata for a placeholder no longer scanned, or simply a
 * different insertion order).
 *
 * `param` is expected to be one of `preset.params` (the modal only ever
 * calls this with one); a caller passing anything else gets `undefined`
 * rather than the server's spans by accident -- `indexOf` returning -1 must
 * never resolve to array index 0.
 */
export function spansForParam(
  preset: McpPreset,
  results: readonly DescriptionSpan[][],
  param: string,
): DescriptionSpan[] | undefined {
  if (preset.def.parameters[param]?.description === undefined) return undefined;
  const position = preset.params.indexOf(param);
  if (position === -1) return undefined;
  return nonEmpty(results[position + 1]);
}
