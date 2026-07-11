/**
 * Pure search-field extractor for the Components page's tile-grid view: the
 * strings `fuzzyFilter` matches a query against for one `McpPreset` -- its
 * name, transport type, source repository name (repo presets only), and its
 * connection line (url or command, via `mcpConnectionFromDef`). Kept separate
 * from `mcpPresetMapping.ts` so it can depend on the repository list without
 * pulling that dependency into the simpler card-prop mappers.
 */
import type { McpPreset } from '@/app/store';
import type { Repository } from '@/services/bridge';
import { mcpConnectionFromDef } from './mcpPresetMapping';

/** Fields the tile grid's search box fuzzy-matches one preset against. */
export function mcpTileSearchText(preset: McpPreset, repositories: readonly Repository[]): string[] {
  const connection = mcpConnectionFromDef(preset.def);
  const repoName =
    preset.repoId !== undefined ? repositories.find((r) => r.id === preset.repoId)?.name : undefined;
  const fields = [preset.name, preset.def.type];
  if (repoName !== undefined) fields.push(repoName);
  if (connection.url !== undefined) fields.push(connection.url);
  if (connection.command !== undefined) fields.push(connection.command);
  return fields;
}
