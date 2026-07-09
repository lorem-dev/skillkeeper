/**
 * Tests for the renderer-local MCP preset validation (see validate.ts for why
 * `validateParamSyntax` is duplicated here rather than imported from
 * `@skillkeeper/core`).
 */
import { describe, it, expect } from 'vitest';
// Core IS importable in the Node/vitest env (unlike the sandboxed renderer);
// used only here to pin the renderer copy against the original (drift guard).
import { validateParamSyntax as coreValidateParamSyntax } from '@skillkeeper/core';
import { validateParamSyntax, validatePreset } from './validate';
import type { McpPresetDraft } from './validate';

const emptyDraft: McpPresetDraft = {
  name: '',
  type: '',
  url: '',
  headers: [],
  command: '',
  args: [],
  env: [],
  rules: '',
};

describe('validateParamSyntax', () => {
  it('accepts a placeholder-free string', () => {
    expect(validateParamSyntax('plain text')).toEqual({ ok: true });
  });

  it('accepts a well-formed placeholder', () => {
    expect(validateParamSyntax('hello {name}')).toEqual({ ok: true });
  });

  it('accepts multiple well-formed placeholders', () => {
    expect(validateParamSyntax('{a}-{b_2}-{C}')).toEqual({ ok: true });
  });

  it('flags an unclosed brace', () => {
    expect(validateParamSyntax('hello {name')).toEqual({ ok: false, index: 6, reason: 'unclosed {' });
  });

  it('flags an empty placeholder', () => {
    expect(validateParamSyntax('hello {}')).toEqual({ ok: false, index: 6, reason: 'empty {}' });
  });

  it('flags an illegal character inside a placeholder', () => {
    expect(validateParamSyntax('hello {na-me}')).toEqual({
      ok: false,
      index: 6,
      reason: 'illegal character in {na-me}',
    });
  });

  describe('drift guard: matches @skillkeeper/core byte-for-byte', () => {
    const cases = [
      'plain text',
      'hello {name}',
      'hello {name',
      'hello {}',
      'hello {na-me}',
      '{a}{b_2}{C3}',
      '{',
      '',
      'trailing {unclosed',
      '{ok}{bad-one}',
    ];
    it.each(cases)('matches core for %j', (text) => {
      expect(validateParamSyntax(text)).toEqual(coreValidateParamSyntax(text));
    });
  });
});

describe('validatePreset', () => {
  it('requires a name', () => {
    const errors = validatePreset({ ...emptyDraft, type: 'stdio', command: 'run' });
    expect(errors.some((e) => e.field === 'name')).toBe(true);
  });

  it('requires a transport type', () => {
    const errors = validatePreset({ ...emptyDraft, name: 'x' });
    expect(errors.some((e) => e.field === 'type')).toBe(true);
  });

  it('requires a command for stdio', () => {
    const errors = validatePreset({ ...emptyDraft, name: 'x', type: 'stdio' });
    expect(errors.some((e) => e.field === 'command')).toBe(true);
  });

  it('requires a url for http', () => {
    const errors = validatePreset({ ...emptyDraft, name: 'x', type: 'http' });
    expect(errors.some((e) => e.field === 'url')).toBe(true);
  });

  it('requires a url for sse', () => {
    const errors = validatePreset({ ...emptyDraft, name: 'x', type: 'sse' });
    expect(errors.some((e) => e.field === 'url')).toBe(true);
  });

  it('does not require url/command from the other transport', () => {
    const stdioErrors = validatePreset({ ...emptyDraft, name: 'x', type: 'stdio', command: 'run' });
    expect(stdioErrors).toEqual([]);
    const httpErrors = validatePreset({ ...emptyDraft, name: 'x', type: 'http', url: 'https://example.com' });
    expect(httpErrors).toEqual([]);
  });

  it('accepts a valid stdio preset with a param in the command', () => {
    const errors = validatePreset({ ...emptyDraft, name: 'x', type: 'stdio', command: 'run {token}' });
    expect(errors).toEqual([]);
  });

  it('accepts a valid http preset with params in url and headers', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'http',
      url: 'https://example.com/{token}',
      headers: [{ key: 'Authorization', value: 'Bearer {token}' }],
    });
    expect(errors).toEqual([]);
  });

  it('flags a param-syntax error in the url', () => {
    const errors = validatePreset({ ...emptyDraft, name: 'x', type: 'http', url: 'https://example.com/{' });
    expect(errors.find((e) => e.field === 'url')).toBeDefined();
  });

  it('flags a param-syntax error in a header value', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'http',
      url: 'https://example.com',
      headers: [{ key: 'X', value: 'bad {}' }],
    });
    expect(errors.find((e) => e.field === 'headers.0.value')).toBeDefined();
  });

  it('flags a param-syntax error in an arg', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'stdio',
      command: 'run',
      args: ['{bad-name}'],
    });
    expect(errors.find((e) => e.field === 'args.0')).toBeDefined();
  });

  it('flags a param-syntax error in an env value', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'stdio',
      command: 'run',
      env: [{ key: 'TOKEN', value: '{bad' }],
    });
    expect(errors.find((e) => e.field === 'env.0.value')).toBeDefined();
  });

  it('does not scan a stale url when the transport is stdio', () => {
    // Values persist across a transport switch: an invalid url typed under
    // http must not keep Save disabled once the user switches to stdio and
    // supplies a valid command -- the url field is not rendered in stdio mode.
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'stdio',
      command: 'run',
      url: 'https://example.com/{bad-name}',
      headers: [{ key: 'X', value: 'also {bad}' }],
    });
    expect(errors).toEqual([]);
  });

  it('scans the url when the transport is http', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'http',
      url: 'https://example.com/{bad-name}',
    });
    expect(errors.find((e) => e.field === 'url')).toBeDefined();
  });

  it('does not scan stale command/args/env when the transport is http', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'http',
      url: 'https://example.com',
      command: 'run {bad',
      args: ['{bad-arg}'],
      env: [{ key: 'TOKEN', value: '{bad' }],
    });
    expect(errors).toEqual([]);
  });

  it('flags a param-syntax error in rules', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'stdio',
      command: 'run',
      rules: 'Use {param',
    });
    expect(errors.find((e) => e.field === 'rules')).toBeDefined();
  });

  it('ignores header/env rows whose key is empty', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'http',
      url: 'https://example.com',
      headers: [{ key: '', value: 'bad {' }],
      env: [],
    });
    expect(errors).toEqual([]);
  });

  it('reports only the first param-syntax offender', () => {
    const errors = validatePreset({
      ...emptyDraft,
      name: 'x',
      type: 'http',
      url: 'https://example.com/{bad-url}',
      headers: [{ key: 'X', value: 'also {bad-header}' }],
    });
    const paramErrors = errors.filter((e) => e.field === 'url' || e.field === 'headers.0.value');
    expect(paramErrors).toHaveLength(1);
    expect(paramErrors[0]?.field).toBe('url');
  });
});
