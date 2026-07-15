/**
 * JSON-based native MCP config writers: claude/cursor (`mcpServers`), copilot
 * (`servers`), and opencode (`mcp`, its own local/remote server shape). All
 * four share the same parse/merge/serialize skeleton -- only the container key
 * and the per-server object shape differ -- so `createJsonWriter` takes both
 * as configuration and the shared logic lives once, here.
 *
 * Unrelated top-level keys and unrelated container entries are preserved.
 * Output is deterministic: keys are sorted recursively before serializing,
 * matching the convention in `hookJson.ts`.
 */
import type { McpServerDef } from '../model.js';
import type { McpConfigWriter } from './types.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively sort object keys for stable, deterministic serialization. */
function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

/** Serialize with sorted keys and two-space indentation. */
function serialize(value: JsonValue): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function parseRoot(text: string): { [key: string]: JsonValue } {
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text) as JsonValue;
  if (!isObject(parsed)) {
    throw new Error('JSON root must be an object');
  }
  return parsed;
}

/**
 * The claude/cursor/copilot server shape: a `type`-tagged object.
 * - stdio: `{ type: 'stdio', command, args?, env? }` (args/env omitted when absent)
 * - http:  `{ type: 'http', url, headers? }`
 * - sse:   `{ type: 'sse', url, headers? }`
 */
export function toStandardServerJson(def: McpServerDef): JsonValue {
  if (def.type === 'stdio') {
    if (def.command === undefined) {
      throw new Error('stdio server definition requires "command"');
    }
    const obj: { [key: string]: JsonValue } = { type: 'stdio', command: def.command };
    if (def.args !== undefined) obj['args'] = [...def.args];
    if (def.env !== undefined) obj['env'] = { ...def.env };
    return obj;
  }
  if (def.url === undefined) {
    throw new Error(`${def.type} server definition requires "url"`);
  }
  const obj: { [key: string]: JsonValue } = { type: def.type, url: def.url };
  if (def.headers !== undefined) obj['headers'] = { ...def.headers };
  return obj;
}

/**
 * The opencode server shape: `local` (stdio) with `command` as an array
 * (command followed by its args) and `env` renamed `environment`, or `remote`
 * (http and sse both map to `remote`).
 */
export function toOpencodeServerJson(def: McpServerDef): JsonValue {
  if (def.type === 'stdio') {
    if (def.command === undefined) {
      throw new Error('stdio server definition requires "command"');
    }
    const obj: { [key: string]: JsonValue } = {
      type: 'local',
      command: [def.command, ...(def.args ?? [])],
      enabled: true,
    };
    if (def.env !== undefined) obj['environment'] = { ...def.env };
    return obj;
  }
  if (def.url === undefined) {
    throw new Error(`${def.type} server definition requires "url"`);
  }
  const obj: { [key: string]: JsonValue } = { type: 'remote', url: def.url, enabled: true };
  if (def.headers !== undefined) obj['headers'] = { ...def.headers };
  return obj;
}

/**
 * Build a JSON writer keyed on `containerKey` (e.g. `mcpServers`, `servers`,
 * `mcp`), mapping each server def through `toServerObject`.
 */
export function createJsonWriter(
  containerKey: string,
  toServerObject: (def: McpServerDef) => JsonValue,
): McpConfigWriter {
  return {
    upsert(text, name, def) {
      const root = parseRoot(text);
      const containerRaw = root[containerKey];
      const container: { [key: string]: JsonValue } = isObject(containerRaw)
        ? { ...containerRaw }
        : {};
      container[name] = toServerObject(def);
      const next: { [key: string]: JsonValue } = { ...root, [containerKey]: container };
      return serialize(next);
    },
    remove(text, name) {
      if (text.trim() === '') return text;
      const root = parseRoot(text);
      const containerRaw = root[containerKey];
      if (!isObject(containerRaw) || !(name in containerRaw)) {
        return text;
      }
      const container: { [key: string]: JsonValue } = { ...containerRaw };
      delete container[name];
      const next: { [key: string]: JsonValue } = { ...root, [containerKey]: container };
      return serialize(next);
    },
    existingNames(text) {
      if (text.trim() === '') return [];
      const root = parseRoot(text);
      const containerRaw = root[containerKey];
      return isObject(containerRaw) ? Object.keys(containerRaw) : [];
    },
  };
}
