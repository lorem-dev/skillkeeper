/**
 * Tests for the MCP pages' pure preset-mapping helpers: deriving a card's
 * connection line from a preset's def, converting a full `McpPreset` into the
 * `ManualMcpPreset` shape the editor modal edits, and the search-field
 * extractor `ComponentsPage`'s search box filters presets by.
 */
import { describe, it, expect } from 'vitest';
import type { McpServerDef } from '@/services/bridge';
import type { McpPreset } from '@/app/store';
import { mcpConnectionFromDef, toManualPreset } from './mcpPresetMapping';

describe('mcpConnectionFromDef', () => {
  it('joins command and args for stdio', () => {
    const def: McpServerDef = { name: 'fs', type: 'stdio', command: 'npx', args: ['-y', 'server', '{root}'] };
    expect(mcpConnectionFromDef(def)).toEqual({ command: 'npx -y server {root}' });
  });

  it('returns just the command when there are no args', () => {
    const def: McpServerDef = { name: 'fs', type: 'stdio', command: 'my-server' };
    expect(mcpConnectionFromDef(def)).toEqual({ command: 'my-server' });
  });

  it('drops empty-string args when joining the command', () => {
    const def: McpServerDef = { name: 'fs', type: 'stdio', command: 'my-server', args: ['', '--flag'] };
    expect(mcpConnectionFromDef(def)).toEqual({ command: 'my-server --flag' });
  });

  it('returns empty when stdio has no command', () => {
    const def: McpServerDef = { name: 'fs', type: 'stdio' };
    expect(mcpConnectionFromDef(def)).toEqual({});
  });

  it('returns the url for http', () => {
    const def: McpServerDef = { name: 'gh', type: 'http', url: 'https://api.example.com/mcp' };
    expect(mcpConnectionFromDef(def)).toEqual({ url: 'https://api.example.com/mcp' });
  });

  it('returns the url for sse', () => {
    const def: McpServerDef = { name: 'feed', type: 'sse', url: 'https://mcp.example.com/sse' };
    expect(mcpConnectionFromDef(def)).toEqual({ url: 'https://mcp.example.com/sse' });
  });

  it('returns empty when http/sse has no url', () => {
    const def: McpServerDef = { name: 'gh', type: 'http' };
    expect(mcpConnectionFromDef(def)).toEqual({});
  });
});

describe('toManualPreset', () => {
  it('maps a stdio manual preset, copying args/env into fresh mutable containers', () => {
    const preset: McpPreset = {
      id: 'manual-1',
      origin: 'manual',
      name: 'github',
      def: {
        name: 'github',
        type: 'stdio',
        command: 'github-mcp',
        args: ['--token', '{token}'],
        env: { TOKEN: '{token}' },
        rules: 'Use {token} carefully.',
      },
      hash: 'sha256:x',
      params: ['token'],
      hasRules: true,
    };

    const manual = toManualPreset(preset);
    expect(manual).toEqual({
      id: 'manual-1',
      name: 'github',
      type: 'stdio',
      url: undefined,
      headers: undefined,
      command: 'github-mcp',
      args: ['--token', '{token}'],
      env: { TOKEN: '{token}' },
      rules: 'Use {token} carefully.',
    });
  });

  it('maps an http preset, including headers, and omits stdio-only fields', () => {
    const preset: McpPreset = {
      id: 'repo:repo-1:devtools:linear',
      origin: 'repo',
      name: 'linear',
      def: {
        name: 'linear',
        type: 'http',
        url: 'https://api.linear.app/{workspace}',
        headers: { Authorization: 'Bearer {token}' },
      },
      hash: 'sha256:y',
      params: ['workspace', 'token'],
      hasRules: false,
      repoId: 'repo-1',
    };

    const manual = toManualPreset(preset);
    expect(manual.url).toBe('https://api.linear.app/{workspace}');
    expect(manual.headers).toEqual({ Authorization: 'Bearer {token}' });
    expect(manual.command).toBeUndefined();
    expect(manual.args).toBeUndefined();
    expect(manual.env).toBeUndefined();
  });
});
