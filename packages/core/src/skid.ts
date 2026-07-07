import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { SKID_FILE } from './hashing.js';

export { SKID_FILE };

/** Current `.skid.yml` schema version. */
export const SKID_SCHEMA = 1;

/**
 * The SkillKeeper identity file dropped into every installed skill. Records
 * where the skill came from (remote + name + optional group) and a content hash
 * of the skill body, so an install can later be matched to a repository and
 * checked for updates -- even after the local state store is lost or the skill
 * travels into a project via git.
 */
export interface SkidFile {
  readonly schema: number;
  /** Source repository remote URL (absent for local-path installs). */
  readonly remote?: string;
  readonly name: string;
  readonly group?: string;
  /** Content hash of the skill body (see `contentHash`). */
  readonly version: string;
}

const HEADER = '# SkillKeeper identity file. Generated on install; do not edit.\n';

/** Serialize a `.skid.yml`, omitting absent optional fields, with a header. */
export function serializeSkid(skid: SkidFile): string {
  const body: Record<string, unknown> = { schema: skid.schema, name: skid.name };
  if (skid.group !== undefined) body['group'] = skid.group;
  if (skid.remote !== undefined) body['remote'] = skid.remote;
  body['version'] = skid.version;
  return HEADER + stringifyYaml(body);
}

/** Parse a `.skid.yml`. Returns undefined when the text is not a valid skid. */
export function parseSkid(text: string): SkidFile | undefined {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const name = rec['name'];
  const version = rec['version'];
  const schema = rec['schema'];
  const remote = rec['remote'];
  const group = rec['group'];
  if (typeof name !== 'string' || typeof version !== 'string') return undefined;
  return {
    schema: typeof schema === 'number' ? schema : SKID_SCHEMA,
    remote: typeof remote === 'string' ? remote : undefined,
    name,
    group: typeof group === 'string' ? group : undefined,
    version,
  };
}
