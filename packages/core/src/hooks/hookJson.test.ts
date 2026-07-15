import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decapsulateForeignMarkers,
  encapsulateForeignMarkers,
  findOwnedNode,
  mergeHookNode,
  MARKER_FIELD,
  removeHookNode,
} from './hookJson.js';

describe('mergeHookNode', () => {
  it('adds a node tagged with the ownership marker, preserving a pre-existing user entry', () => {
    const initial = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-thing' }] }],
      },
    });
    const node = { matcher: 'Edit', hooks: [{ type: 'command', command: 'sk-thing' }] };
    const merged = mergeHookNode(initial, 'hooks.PreToolUse', node, {
      markerId: 'mid1',
      label: 'g/n:h',
    });
    const parsed = JSON.parse(merged);
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    // The user's entry is untouched and stays first.
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('user-thing');
    expect(parsed.hooks.PreToolUse[0][MARKER_FIELD]).toBeUndefined();
    // The new entry carries the ownership marker.
    const owned = parsed.hooks.PreToolUse[1];
    expect(owned.matcher).toBe('Edit');
    expect(owned[MARKER_FIELD]).toEqual({ id: 'mid1', label: 'g/n:h' });
  });

  it('creates the key path when it does not exist', () => {
    const merged = mergeHookNode(
      '{}',
      'hooks.PostToolUse',
      { matcher: 'X', hooks: [] },
      {
        markerId: 'm',
        label: 'a:b',
      },
    );
    const parsed = JSON.parse(merged);
    expect(Array.isArray(parsed.hooks.PostToolUse)).toBe(true);
    expect(parsed.hooks.PostToolUse[0][MARKER_FIELD].id).toBe('m');
  });

  it('emits stable, sorted key order', () => {
    const merged = mergeHookNode(
      '{}',
      'hooks.E',
      { zeta: 1, alpha: 2 },
      {
        markerId: 'm',
        label: 'l',
      },
    );
    // Top-level keys and nested keys are alphabetically ordered for stability.
    const idxAlpha = merged.indexOf('"alpha"');
    const idxZeta = merged.indexOf('"zeta"');
    expect(idxAlpha).toBeGreaterThan(-1);
    expect(idxAlpha).toBeLessThan(idxZeta);
  });

  it('replaces an existing owned node with the same markerId rather than duplicating', () => {
    let json = mergeHookNode('{}', 'hooks.E', { v: 1 }, { markerId: 'same', label: 'l' });
    json = mergeHookNode(json, 'hooks.E', { v: 2 }, { markerId: 'same', label: 'l' });
    const parsed = JSON.parse(json);
    expect(parsed.hooks.E).toHaveLength(1);
    expect(parsed.hooks.E[0].v).toBe(2);
  });

  it('is valid JSON ending without a trailing newline by default', () => {
    const merged = mergeHookNode('{}', 'hooks.E', { v: 1 }, { markerId: 'm', label: 'l' });
    expect(() => JSON.parse(merged)).not.toThrow();
  });

  it('throws when the target key path holds a non-array value', () => {
    const json = JSON.stringify({ hooks: { E: 'not-an-array' } });
    expect(() => mergeHookNode(json, 'hooks.E', { v: 1 }, { markerId: 'm', label: 'l' })).toThrow();
  });

  it('throws on malformed JSON input', () => {
    expect(() => mergeHookNode('{bad', 'hooks.E', {}, { markerId: 'm', label: 'l' })).toThrow();
  });

  it('reuses an existing object along the key path', () => {
    const initial = JSON.stringify({ hooks: { existing: true } });
    const merged = mergeHookNode(initial, 'hooks.E', { v: 1 }, { markerId: 'm', label: 'l' });
    const parsed = JSON.parse(merged);
    // The pre-existing sibling under hooks is preserved.
    expect(parsed.hooks.existing).toBe(true);
    expect(parsed.hooks.E[0].v).toBe(1);
  });

  it('throws when an intermediate path segment is not an object', () => {
    const initial = JSON.stringify({ hooks: 'a-string' });
    expect(() =>
      mergeHookNode(initial, 'hooks.E.deep', { v: 1 }, { markerId: 'm', label: 'l' }),
    ).toThrow(/not an object/);
  });

  it('throws when the JSON root is not an object', () => {
    expect(() => mergeHookNode('[1,2,3]', 'hooks.E', {}, { markerId: 'm', label: 'l' })).toThrow(
      /root must be an object/,
    );
  });
});

describe('removeHookNode', () => {
  it('removes only the owned node, leaving the user entry intact', () => {
    const initial = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'user' }] }],
      },
    });
    const withOwned = mergeHookNode(
      initial,
      'hooks.PreToolUse',
      { matcher: 'Edit' },
      {
        markerId: 'mid',
        label: 'l',
      },
    );
    const removed = removeHookNode(withOwned, 'mid');
    const parsed = JSON.parse(removed);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash');
  });

  it('prunes an array that becomes empty after removal', () => {
    const json = mergeHookNode('{}', 'hooks.E', { v: 1 }, { markerId: 'm', label: 'l' });
    const removed = removeHookNode(json, 'm');
    const parsed = JSON.parse(removed);
    expect(parsed.hooks?.E).toBeUndefined();
  });

  it('returns the input structurally unchanged when the markerId is absent', () => {
    const json = mergeHookNode('{}', 'hooks.E', { v: 1 }, { markerId: 'm', label: 'l' });
    const removed = removeHookNode(json, 'other');
    expect(JSON.parse(removed)).toEqual(JSON.parse(json));
  });

  it('removes owned nodes regardless of where they sit in the tree', () => {
    let json = mergeHookNode('{}', 'hooks.A', { v: 1 }, { markerId: 'a', label: 'l' });
    json = mergeHookNode(json, 'hooks.B', { v: 2 }, { markerId: 'b', label: 'l' });
    const removed = removeHookNode(json, 'b');
    const parsed = JSON.parse(removed);
    expect(parsed.hooks.A).toHaveLength(1);
    expect(parsed.hooks.B).toBeUndefined();
  });

  it('throws on malformed JSON input', () => {
    expect(() => removeHookNode('{bad', 'm')).toThrow();
  });

  it('finds and removes an owned node nested beneath non-owned array entries', () => {
    // The owned node sits inside an object that is itself an element of an
    // array, so removal must recurse through non-matching array entries.
    const json = JSON.stringify({
      groups: [
        { name: 'a', items: [{ plain: 1 }] },
        { name: 'b', items: [{ _skillkeeper: { id: 'deep', label: 'l' }, v: 9 }] },
      ],
    });
    const removed = removeHookNode(json, 'deep');
    const parsed = JSON.parse(removed);
    // The owned node is removed; its now-empty array is pruned (consistent with
    // top-level pruning), leaving the sibling group untouched.
    expect(parsed.groups[1].items).toBeUndefined();
    expect(parsed.groups[0].items).toEqual([{ plain: 1 }]);
  });
});

describe('findOwnedNode and canonicalJson', () => {
  it('finds a node nested beneath non-owned array entries and objects', () => {
    const json = JSON.stringify({
      a: [{ plain: 1 }, { nested: { items: [{ _skillkeeper: { id: 'x', label: 'l' }, v: 1 }] } }],
    });
    const node = findOwnedNode(json, 'x') as { v: number };
    expect(node.v).toBe(1);
  });

  it('returns undefined when no node carries the marker id', () => {
    expect(findOwnedNode(JSON.stringify({ a: [{ b: 1 }] }), 'absent')).toBeUndefined();
  });

  it('canonicalJson sorts keys deterministically regardless of input order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('canonicalJson passes through primitives and arrays', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('encapsulate/decapsulate foreign markers', () => {
  it('round-trips arbitrary content', () => {
    for (const s of ['plain', '', 'has _skillkeeper word', '{"_skillkeeper":"x"}']) {
      expect(decapsulateForeignMarkers(encapsulateForeignMarkers(s))).toBe(s);
    }
  });

  it('neutralizes a foreign _skillkeeper token so it cannot be matched as owned', () => {
    const content = '{"hooks":{"E":[{"_skillkeeper":{"id":"forged"},"v":1}]}}';
    const enc = encapsulateForeignMarkers(content);
    expect(enc).not.toMatch(/"_skillkeeper"/);
    // After encapsulation the forged owner is invisible to removeHookNode: when
    // such content is later embedded and merged, removal by "forged" finds
    // nothing because the literal token was escaped.
    expect(decapsulateForeignMarkers(enc)).toBe(content);
  });

  it('does not let an embedded forged marker be removed by removeHookNode', () => {
    // Simulate skill content that smuggled a marker, then was encapsulated and
    // stored as a string value inside a real merged node.
    const smuggled = encapsulateForeignMarkers('{"_skillkeeper":{"id":"forged"}}');
    const json = mergeHookNode(
      '{}',
      'hooks.E',
      { payload: smuggled },
      {
        markerId: 'real',
        label: 'l',
      },
    );
    const afterForged = removeHookNode(json, 'forged');
    expect(JSON.parse(afterForged)).toEqual(JSON.parse(json));
    const afterReal = removeHookNode(json, 'real');
    expect(JSON.parse(afterReal).hooks?.E).toBeUndefined();
  });
});
