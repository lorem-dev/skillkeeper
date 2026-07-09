/**
 * Content hashing for MCP server definitions. The hash excludes `name` so
 * renaming a server does not change its identity hash, and is stable
 * regardless of object key order (matters for `headers`/`env`, whose keys
 * come from user-authored config and may differ in order between reads).
 */

import { createHash } from 'crypto';
import type { McpServerDef } from './mcpModel.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
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

/**
 * Canonical serialization of an MCP server def for hashing: `name` is
 * stripped (identity should survive a rename) and keys are sorted
 * recursively so key order never affects the result.
 */
export function canonicalMcpJson(def: McpServerDef): string {
  const { name: _name, ...rest } = def;
  return JSON.stringify(sortKeys(rest as unknown as JsonValue));
}

/** Content hash of an MCP server def, excluding `name`. */
export function hashMcpDef(def: McpServerDef): string {
  return `sha256:${createHash('sha256').update(canonicalMcpJson(def)).digest('hex')}`;
}
