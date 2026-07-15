import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** Name of the SkillKeeper MCP install ledger, dropped into the skills root. */
export const SKMCP_FILE = '.skmcp.yml';

/** Name of the sibling file holding raw MCP parameter values for the ledger. */
export const SKMCP_PARAMS_FILE = '.skmcp.params.yml';

/** Current `.skmcp.yml` schema version. */
export const SKMCP_SCHEMA = 1;

/**
 * One installed MCP server instance recorded in `.skmcp.yml`. Identity for
 * update matching is `(normalizeRemote(remote), group, source)` for repo
 * presets, or `(local, source)` for manual presets.
 */
export interface SkmcpEntry {
  /** Source repository remote URL (absent for manual presets). */
  readonly remote?: string;
  /** Skill-group directory the preset lives in (absent at the repo root). */
  readonly group?: string;
  /** Manual preset id (present only for manual presets). */
  readonly local?: string;
  /** Server name as it appears in `mcp.yml`/the preset. */
  readonly source: string;
  /** Assigned snake_case instance name (the native config key). */
  readonly name: string;
  /** Hash of the raw server definition at install time. */
  readonly hash: string;
}

/**
 * The SkillKeeper MCP install ledger. Records every installed MCP server
 * instance for one agent+scope so installs can later be matched back to a
 * repository or preset, checked for updates, and removed by exact identity.
 */
export interface SkmcpFile {
  readonly schema: number;
  readonly servers: SkmcpEntry[];
}

const HEADER = '# SkillKeeper MCP install ledger. Generated on install; do not edit.\n';

/** Serialize a `.skmcp.yml`, omitting absent optional fields, with a header. */
export function serializeSkmcp(f: SkmcpFile): string {
  const servers = f.servers.map((s) => {
    const body: Record<string, unknown> = {};
    if (s.remote !== undefined) body['remote'] = s.remote;
    if (s.group !== undefined) body['group'] = s.group;
    if (s.local !== undefined) body['local'] = s.local;
    body['source'] = s.source;
    body['name'] = s.name;
    body['hash'] = s.hash;
    return body;
  });
  return HEADER + stringifyYaml({ schema: f.schema, servers });
}

/**
 * Parse a `.skmcp.yml`. Returns undefined when the text is not valid YAML, or
 * is missing any required field (`schema`, `servers`, or an entry's `source`,
 * `name`, `hash`).
 */
export function parseSkmcp(text: string): SkmcpFile | undefined {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const schema = rec['schema'];
  const serversRaw = rec['servers'];
  if (typeof schema !== 'number' || !Array.isArray(serversRaw)) return undefined;

  const servers: SkmcpEntry[] = [];
  for (const item of serversRaw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const entry = item as Record<string, unknown>;
    const source = entry['source'];
    const name = entry['name'];
    const hash = entry['hash'];
    if (typeof source !== 'string' || typeof name !== 'string' || typeof hash !== 'string') {
      return undefined;
    }
    const remote = entry['remote'];
    const group = entry['group'];
    const local = entry['local'];
    servers.push({
      remote: typeof remote === 'string' ? remote : undefined,
      group: typeof group === 'string' ? group : undefined,
      local: typeof local === 'string' ? local : undefined,
      source,
      name,
      hash,
    });
  }

  return { schema, servers };
}

const PARAMS_HEADER = '# SkillKeeper MCP parameter values. Generated on install; do not edit.\n';

/** Serialize the raw per-instance MCP parameter values, with a header. */
export function serializeSkmcpParams(map: Record<string, Record<string, string>>): string {
  return PARAMS_HEADER + stringifyYaml(map);
}

/**
 * Parse a `.skmcp.params.yml`. Returns `{}` when the text is not valid YAML or
 * not an object at the root; non-string leaf values are dropped.
 */
export function parseSkmcpParams(text: string): Record<string, Record<string, string>> {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return {};
  }
  if (typeof data !== 'object' || data === null) return {};

  const out: Record<string, Record<string, string>> = {};
  for (const [instanceName, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const params: Record<string, string> = {};
    for (const [param, paramValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof paramValue === 'string') params[param] = paramValue;
    }
    out[instanceName] = params;
  }
  return out;
}
