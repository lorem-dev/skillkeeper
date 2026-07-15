import type { McpServerDef } from './mcpModel.js';

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Yields every string field of an MCP server definition that may contain
 * `{param}` placeholders: url, header values, command, args, env values,
 * and rules.
 */
function* stringFields(def: McpServerDef): Generator<string> {
  if (def.url !== undefined) yield def.url;
  if (def.headers !== undefined) {
    for (const value of Object.values(def.headers)) yield value;
  }
  if (def.command !== undefined) yield def.command;
  if (def.args !== undefined) {
    for (const arg of def.args) yield arg;
  }
  if (def.env !== undefined) {
    for (const value of Object.values(def.env)) yield value;
  }
  if (def.rules !== undefined) yield def.rules;
}

/** Scans all fields of an MCP server definition for `{param}` placeholders. */
export function parseParams(def: McpServerDef): string[] {
  const names = new Set<string>();
  for (const text of stringFields(def)) {
    for (const match of text.matchAll(PLACEHOLDER)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The parameter names required by `def` that are absent from `storedValues`
 * (an undefined map counts every parameter as missing). Result is sorted and
 * de-duplicated, mirroring {@link parseParams}. A stored key with an empty
 * string value still counts as present.
 */
export function missingParams(
  def: McpServerDef,
  storedValues: Record<string, string> | undefined,
): string[] {
  const stored = storedValues ?? {};
  return parseParams(def).filter(
    (name) => !Object.prototype.hasOwnProperty.call(stored, name),
  );
}

export type ParamSyntaxResult = { ok: true } | { ok: false; index: number; reason: string };

/**
 * Validates that every `{` in the text opens a well-formed placeholder:
 * a non-empty run of `[A-Za-z0-9_]` characters followed by `}`.
 */
export function validateParamSyntax(text: string): ParamSyntaxResult {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    const close = text.indexOf('}', i + 1);
    if (close === -1) {
      return { ok: false, index: i, reason: 'unclosed {' };
    }
    const name = text.slice(i + 1, close);
    if (name.length === 0) {
      return { ok: false, index: i, reason: 'empty {}' };
    }
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      return { ok: false, index: i, reason: `illegal character in {${name}}` };
    }
    i = close;
  }
  return { ok: true };
}

/**
 * Renders `{param}` placeholders across every field of an MCP server
 * definition, substituting from `values`. Throws if any referenced param
 * has no value.
 */
export function renderParams(def: McpServerDef, values: Record<string, string>): McpServerDef {
  const missing = new Set<string>();

  const render = (text: string): string =>
    text.replace(PLACEHOLDER, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) {
        missing.add(name);
        return '';
      }
      return value;
    });

  const renderRecord = (
    record: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> | undefined => {
    if (record === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = render(value);
    }
    return out;
  };

  const out: McpServerDef = {
    ...def,
    url: def.url !== undefined ? render(def.url) : undefined,
    headers: renderRecord(def.headers),
    command: def.command !== undefined ? render(def.command) : undefined,
    args: def.args !== undefined ? def.args.map((arg) => render(arg)) : undefined,
    env: renderRecord(def.env),
    rules: def.rules !== undefined ? render(def.rules) : undefined,
  };

  if (missing.size > 0) {
    throw new Error(`Missing values for mcp params: ${[...missing].sort().join(', ')}`);
  }

  return out;
}
