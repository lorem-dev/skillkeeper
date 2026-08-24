/**
 * Whether `value` is an acceptable value for one install parameter, given its
 * authoring metadata (or none, for a placeholder with no `McpParameter`
 * entry at all).
 *
 * A parameter with `options` renders as a `Select` in `McpInstallModal`, so
 * only one of those options' own values is ever acceptable -- typed free
 * text is not, even if it happens to be non-blank. Every other parameter
 * (no metadata, or metadata with an empty `options` list) just needs
 * something non-blank, exactly as before options existed.
 */
import type { McpParameter } from '@/services/bridge';

export function paramValueValid(meta: McpParameter | undefined, value: string): boolean {
  const options = meta?.options ?? [];
  if (options.length > 0) return options.some((option) => option.value === value);
  return value.trim() !== '';
}
