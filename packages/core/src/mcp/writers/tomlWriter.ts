/**
 * Codex native MCP config writer: `~/.codex/config.toml`, TOML table
 * `[mcp_servers.<name>]` with keys `command`, `args`, `env`. Codex only
 * supports the `stdio` transport (gated by `supportsTransport` in
 * `index.ts`); `upsert` throws if handed a non-stdio def as a defensive
 * check, mirroring that gate.
 *
 * LIMITATION: this writer round-trips the file through `smol-toml`'s
 * parse/stringify. That preserves all table structure and values but does NOT
 * preserve the user's original comments or formatting -- a config.toml with
 * hand-written comments will lose them on the first SkillKeeper-managed edit.
 * Accepted v1 tradeoff (see the design doc); a comment-preserving TOML editor
 * is out of scope for this task.
 */
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { McpServerDef } from '../mcpModel.js';
import type { McpConfigWriter } from './types.js';

const CONTAINER_KEY = 'mcp_servers';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoot(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  return parseToml(text) as unknown as Record<string, unknown>;
}

function toCodexServerObject(def: McpServerDef): Record<string, unknown> {
  if (def.type !== 'stdio') {
    throw new Error(`codex only supports the stdio transport, got "${def.type}"`);
  }
  if (def.command === undefined) {
    throw new Error('stdio server definition requires "command"');
  }
  const obj: Record<string, unknown> = { command: def.command };
  if (def.args !== undefined) obj['args'] = [...def.args];
  if (def.env !== undefined) obj['env'] = { ...def.env };
  return obj;
}

export function createCodexTomlWriter(): McpConfigWriter {
  return {
    upsert(text, name, def) {
      const root = parseRoot(text);
      const containerRaw = root[CONTAINER_KEY];
      const container: Record<string, unknown> = isRecord(containerRaw) ? { ...containerRaw } : {};
      container[name] = toCodexServerObject(def);
      const next: Record<string, unknown> = { ...root, [CONTAINER_KEY]: container };
      return stringifyToml(next);
    },
    remove(text, name) {
      if (text.trim() === '') return text;
      const root = parseRoot(text);
      const containerRaw = root[CONTAINER_KEY];
      if (!isRecord(containerRaw) || !(name in containerRaw)) {
        return text;
      }
      const container: Record<string, unknown> = { ...containerRaw };
      delete container[name];
      const next: Record<string, unknown> = { ...root, [CONTAINER_KEY]: container };
      return stringifyToml(next);
    },
    existingNames(text) {
      if (text.trim() === '') return [];
      const root = parseRoot(text);
      const containerRaw = root[CONTAINER_KEY];
      return isRecord(containerRaw) ? Object.keys(containerRaw) : [];
    },
  };
}
