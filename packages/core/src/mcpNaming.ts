/**
 * Deriving a native-config-safe instance name for an MCP server: snake_case
 * the source name, then allocate the smallest free `<snake>_<n>` suffix
 * against the names already present in the target config.
 */

/**
 * Convert an arbitrary display name into a snake_case identifier.
 *
 * Rule (applied in order):
 * 1. Insert `_` before any uppercase letter that immediately follows a
 *    lowercase letter or a digit -- this splits camelCase boundaries
 *    (`GitHub` -> `Git_Hub`) while leaving runs of caps (`MCP`) intact.
 * 2. Lowercase the whole string.
 * 3. Replace every run of non-alphanumeric characters with a single `_`.
 * 4. Trim leading/trailing `_`.
 *
 * Example: `'GitHub MCP'` -> `'Git_Hub MCP'` -> `'git_hub mcp'` ->
 * `'git_hub_mcp'` -> `'git_hub_mcp'`.
 */
export function toSnakeCase(name: string): string {
  const split = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  const lowered = split.toLowerCase();
  const collapsed = lowered.replace(/[^a-z0-9]+/g, '_');
  return collapsed.replace(/^_+/, '').replace(/_+$/, '');
}

/**
 * Allocate an instance name for a newly-added MCP server: snake_case the
 * source name, then append the smallest `_<n>` (n >= 1) not already present
 * in `existing`. `existing` must include every name already in the target
 * native config, whether or not SkillKeeper owns it, so the result never
 * collides with anything already there.
 */
export function allocateInstanceName(source: string, existing: readonly string[]): string {
  const base = toSnakeCase(source);
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}
