import { describe, expect, it } from 'vitest';
import { canonicalMcpJson, hashMcpDef } from './mcpHashing.js';

describe('hashMcpDef', () => {
  it('excludes name from the hash', () => {
    const a = { name: 'github', type: 'http', url: 'u' } as const;
    const b = { name: 'renamed', type: 'http', url: 'u' } as const;
    expect(hashMcpDef(a)).toBe(hashMcpDef(b));
  });

  it('is stable across key order', () => {
    expect(
      canonicalMcpJson({ name: 'x', type: 'http', url: 'u', headers: { B: '1', A: '2' } }),
    ).toBe(canonicalMcpJson({ name: 'x', type: 'http', headers: { A: '2', B: '1' }, url: 'u' }));
  });

  it('changes when url/rules change', () => {
    const base = { name: 'x', type: 'http', url: 'u' } as const;
    expect(hashMcpDef(base)).not.toBe(hashMcpDef({ ...base, url: 'v' }));
    expect(hashMcpDef(base)).not.toBe(hashMcpDef({ ...base, rules: 'be careful' }));
  });

  it('produces a sha256: prefixed hex digest', () => {
    const hash = hashMcpDef({ name: 'x', type: 'http', url: 'u' });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across env/args key order for stdio servers', () => {
    const a = {
      name: 'x',
      type: 'stdio',
      command: 'cmd',
      args: ['--a', '--b'],
      env: { FOO: '1', BAR: '2' },
    } as const;
    const b = {
      name: 'x',
      type: 'stdio',
      command: 'cmd',
      args: ['--a', '--b'],
      env: { BAR: '2', FOO: '1' },
    } as const;
    expect(hashMcpDef(a)).toBe(hashMcpDef(b));
  });

  it('does not sort array element order (args order is significant)', () => {
    const a = { name: 'x', type: 'stdio', command: 'cmd', args: ['--a', '--b'] } as const;
    const b = { name: 'x', type: 'stdio', command: 'cmd', args: ['--b', '--a'] } as const;
    expect(hashMcpDef(a)).not.toBe(hashMcpDef(b));
  });
});
