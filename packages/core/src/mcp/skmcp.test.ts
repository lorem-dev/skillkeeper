import { describe, expect, it } from 'vitest';
import {
  parseSkmcp,
  parseSkmcpParams,
  serializeSkmcp,
  serializeSkmcpParams,
  SKMCP_SCHEMA,
} from './skmcp.js';

describe('serializeSkmcp / parseSkmcp', () => {
  it('round-trips a repo entry with remote and group', () => {
    const file = {
      schema: SKMCP_SCHEMA,
      servers: [
        {
          remote: 'git@github.com:acme/mcps.git',
          group: 'devtools',
          source: 'github',
          name: 'github_1',
          hash: 'sha256:abc',
        },
      ],
    };
    const text = serializeSkmcp(file);
    expect(text.startsWith('#')).toBe(true);
    expect(parseSkmcp(text)).toEqual(file);
  });

  it('round-trips a manual entry with local, omitting absent remote/group', () => {
    const file = {
      schema: 1,
      servers: [{ local: 'preset-1', source: 'custom', name: 'custom_1', hash: 'sha256:def' }],
    };
    const text = serializeSkmcp(file);
    expect(text).not.toContain('remote:');
    expect(text).not.toContain('group:');
    expect(parseSkmcp(text)).toEqual(file);
  });

  it('omits absent optional fields on entries with no remote/group/local', () => {
    const file = {
      schema: 1,
      servers: [{ source: 'github', name: 'github_1', hash: 'sha256:abc' }],
    };
    const text = serializeSkmcp(file);
    expect(text).not.toContain('remote:');
    expect(text).not.toContain('group:');
    expect(text).not.toContain('local:');
    expect(parseSkmcp(text)).toEqual(file);
  });

  it('returns undefined for malformed yaml', () => {
    expect(parseSkmcp(': : :')).toBeUndefined();
    expect(parseSkmcp('42')).toBeUndefined();
  });

  it('returns undefined when required fields are missing', () => {
    expect(parseSkmcp('servers: []')).toBeUndefined(); // no schema
    expect(parseSkmcp('schema: 1')).toBeUndefined(); // no servers
    expect(parseSkmcp('schema: 1\nservers:\n  - source: github\n    name: g1\n')).toBeUndefined(); // no hash
    expect(parseSkmcp('schema: 1\nservers:\n  - name: g1\n    hash: sha256:x\n')).toBeUndefined(); // no source
    expect(parseSkmcp('schema: 1\nservers:\n  - source: github\n    hash: sha256:x\n')).toBeUndefined(); // no name
  });

  it('accepts an empty servers list', () => {
    expect(parseSkmcp('schema: 1\nservers: []\n')).toEqual({ schema: 1, servers: [] });
  });
});

describe('serializeSkmcpParams / parseSkmcpParams', () => {
  it('round-trips per-instance param maps', () => {
    const map = {
      github_1: { token: 'abc', org: 'acme' },
      slack_1: { webhook: 'https://example.com/hook' },
    };
    const text = serializeSkmcpParams(map);
    expect(text.startsWith('#')).toBe(true);
    expect(parseSkmcpParams(text)).toEqual(map);
  });

  it('round-trips an empty map', () => {
    const text = serializeSkmcpParams({});
    expect(parseSkmcpParams(text)).toEqual({});
  });

  it('returns {} for malformed yaml or non-object roots', () => {
    expect(parseSkmcpParams(': : :')).toEqual({});
    expect(parseSkmcpParams('42')).toEqual({});
  });
});
