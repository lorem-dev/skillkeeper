import { it, expect } from 'vitest';
import { parseParams, validateParamSyntax, renderParams } from './mcpParams.js';

const def = { name: 'github', type: 'http', url: 'https://{host}/mcp',
  headers: { Authorization: 'Bearer {token}' }, rules: 'host={host}' } as const;

it('scans params across fields, unique + sorted', () => {
  expect(parseParams(def)).toEqual(['host', 'token']);
});
it('scans stdio args/env', () => {
  expect(parseParams({ name: 'x', type: 'stdio', command: 'run', args: ['{a}'], env: { E: '{b}' } }))
    .toEqual(['a', 'b']);
});
it('validates syntax', () => {
  expect(validateParamSyntax('ok {a}')).toEqual({ ok: true });
  expect(validateParamSyntax('bad {}').ok).toBe(false);
  expect(validateParamSyntax('bad {a').ok).toBe(false);
});
it('renders values into every field', () => {
  const out = renderParams(def, { host: 'h', token: 't' });
  expect(out.url).toBe('https://h/mcp');
  expect(out.headers?.['Authorization']).toBe('Bearer t');
  expect(out.rules).toBe('host=h');
});
it('throws listing missing params', () => {
  expect(() => renderParams(def, { host: 'h' })).toThrow(/token/);
});
