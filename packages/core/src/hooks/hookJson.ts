/**
 * JSON-merge hook strategy: merge a node into a JSON config (for example Claude
 * `settings.json` under `hooks`) and tag it with a reserved `_skillkeeper`
 * ownership marker so it can be verified and removed precisely. Existing user
 * entries are preserved and key order is stable.
 */

/** The reserved field that marks a SkillKeeper-owned JSON node. */
export const MARKER_FIELD = '_skillkeeper';

/** Guard token used to neutralize foreign occurrences of the marker field. */
const GUARD = 'SK7MARKERGUARD7';

/** Ownership marker payload carried on an owned node. */
export interface OwnershipMarker {
  readonly id: string;
  readonly label: string;
}

/** Options identifying the owner of a merged node. */
export interface MergeOptions {
  readonly markerId: string;
  readonly label: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function parse(jsonText: string): JsonValue {
  return JSON.parse(jsonText) as JsonValue;
}

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

/** Serialize with sorted keys and two-space indentation. */
function serialize(value: JsonValue): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

/** Canonical, compact serialization (sorted keys) for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value as JsonValue));
}

/**
 * Find the owned node carrying `markerId` anywhere in the parsed JSON, or
 * undefined when absent. Used by verify to recompute a node's content hash.
 */
export function findOwnedNode(jsonText: string, markerId: string): unknown {
  const root = parse(jsonText);
  let found: JsonValue | undefined;
  const walk = (value: JsonValue): void => {
    if (found !== undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (ownerId(entry) === markerId) {
          found = entry;
          return;
        }
        walk(entry);
      }
    } else if (isObject(value)) {
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (child !== undefined) walk(child);
      }
    }
  };
  walk(root);
  return found;
}

function ownerId(node: JsonValue): string | undefined {
  if (!isObject(node)) return undefined;
  const marker = node[MARKER_FIELD];
  if (marker !== undefined && isObject(marker) && typeof marker['id'] === 'string') {
    return marker['id'];
  }
  return undefined;
}

/**
 * Merge a node into the array at `keyPath` (dotted, for example
 * `hooks.PreToolUse`), tagging it with the ownership marker. Missing path
 * segments are created. An existing owned node with the same `markerId` is
 * replaced rather than duplicated. Returns valid JSON with stable key order.
 *
 * @throws SyntaxError on malformed JSON, or Error when the path holds a
 *   non-array value.
 */
export function mergeHookNode(
  jsonText: string,
  keyPath: string,
  node: Record<string, unknown>,
  opts: MergeOptions,
): string {
  const root = parse(jsonText);
  if (!isObject(root)) {
    throw new Error('JSON root must be an object');
  }
  const segments = keyPath.split('.');
  let cursor: { [key: string]: JsonValue } = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = cursor[seg];
    if (next === undefined) {
      const created: { [key: string]: JsonValue } = {};
      cursor[seg] = created;
      cursor = created;
    } else if (isObject(next)) {
      cursor = next;
    } else {
      throw new Error(`Path segment "${seg}" is not an object`);
    }
  }

  const lastSeg = segments[segments.length - 1]!;
  const arr = cursor[lastSeg];
  let target: JsonValue[];
  if (arr === undefined) {
    target = [];
    cursor[lastSeg] = target;
  } else if (Array.isArray(arr)) {
    target = arr;
  } else {
    throw new Error(`Path "${keyPath}" does not point to an array`);
  }

  const marker: { [key: string]: JsonValue } = { id: opts.markerId, label: opts.label };
  const owned: { [key: string]: JsonValue } = {
    ...(node as { [key: string]: JsonValue }),
    [MARKER_FIELD]: marker,
  };

  const existingIndex = target.findIndex((entry) => ownerId(entry) === opts.markerId);
  if (existingIndex === -1) {
    target.push(owned);
  } else {
    target[existingIndex] = owned;
  }

  return serialize(root);
}

/** Recursively remove owned nodes matching `markerId`; prune empty arrays. */
function pruneOwned(value: JsonValue, markerId: string): JsonValue {
  if (Array.isArray(value)) {
    const kept = value
      .filter((entry) => ownerId(entry) !== markerId)
      .map((entry) => pruneOwned(entry, markerId));
    return kept;
  }
  if (isObject(value)) {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child === undefined) continue;
      const pruned = pruneOwned(child, markerId);
      // Drop arrays that became empty as a result of removal.
      if (Array.isArray(pruned) && pruned.length === 0 && Array.isArray(child)) {
        continue;
      }
      out[key] = pruned;
    }
    return out;
  }
  return value;
}

/**
 * Remove exactly the owned node(s) carrying `markerId`, wherever they sit in the
 * tree, and prune any array left empty. Returns valid JSON with stable key
 * order. Unmatched ids leave the document structurally unchanged.
 *
 * @throws SyntaxError on malformed JSON.
 */
export function removeHookNode(jsonText: string, markerId: string): string {
  const root = parse(jsonText);
  return serialize(pruneOwned(root, markerId));
}

/**
 * Escape any foreign occurrence of the ownership marker field in arbitrary
 * content so it cannot be parsed as an owned node. Reversible via
 * {@link decapsulateForeignMarkers}.
 */
export function encapsulateForeignMarkers(content: string): string {
  return content
    .split(GUARD)
    .join(GUARD + GUARD)
    .split(MARKER_FIELD)
    .join(`_${GUARD}skillkeeper`);
}

/** Inverse of {@link encapsulateForeignMarkers}. */
export function decapsulateForeignMarkers(content: string): string {
  return content
    .split(`_${GUARD}skillkeeper`)
    .join(MARKER_FIELD)
    .split(GUARD + GUARD)
    .join(GUARD);
}
