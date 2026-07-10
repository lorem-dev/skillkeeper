/**
 * Pure mapping helpers for the MCP page: deriving an `McpCard`'s connection
 * line from a preset's def, converting a full `McpPreset` into the
 * `ManualMcpPreset` shape `McpEditModal` edits (manual presets only), and the
 * text fields the page's search box matches against.
 */
import type { McpServerDef } from '@/services/bridge';
import type { McpPreset } from '@/app/store';
import type { ManualMcpPreset } from '@/features/mcpEdit';

/** Connection info derived from a def for the card's connection line: exactly
 *  one of `url` (http/sse) or `command` (stdio, joined with its args) is set. */
export interface McpConnection {
  readonly url?: string;
  readonly command?: string;
}

export function mcpConnectionFromDef(def: McpServerDef): McpConnection {
  if (def.type === 'stdio') {
    const parts = [def.command, ...(def.args ?? [])].filter(
      (part): part is string => part !== undefined && part !== '',
    );
    return parts.length > 0 ? { command: parts.join(' ') } : {};
  }
  return def.url !== undefined && def.url !== '' ? { url: def.url } : {};
}

/**
 * Converts a manual-origin `McpPreset` into the `ManualMcpPreset` shape the
 * editor modal expects: mutable `args`/`headers`/`env` (the def's are
 * readonly), no `origin`/`hash`/`params`/etc.
 */
export function toManualPreset(preset: McpPreset): ManualMcpPreset {
  const { def } = preset;
  return {
    id: preset.id,
    name: preset.name,
    type: def.type,
    url: def.url,
    headers: def.headers !== undefined ? { ...def.headers } : undefined,
    command: def.command,
    args: def.args !== undefined ? [...def.args] : undefined,
    env: def.env !== undefined ? { ...def.env } : undefined,
    rules: def.rules,
  };
}

/**
 * The text fields an `McpPreset` is matched against by the MCP page's search
 * box: its name, transport type, source repository name (repo-discovered
 * presets only -- empty for manual ones), and its connection endpoint (the
 * URL or command line `mcpConnectionFromDef` derives for the card). Mirrors
 * the field set ProjectsPage/RepositoriesPage search their own cards on.
 */
export function mcpSearchFields(preset: McpPreset, repoName: string | undefined): readonly string[] {
  const connection = mcpConnectionFromDef(preset.def);
  return [preset.name, preset.def.type, repoName ?? '', connection.url ?? '', connection.command ?? ''];
}
