import { describe, expect, it } from 'vitest';
import type { McpServerDef } from '../model.js';
import { mcpDestination, supportsTransport, writerFor } from './index.js';

const stdioDef: McpServerDef = {
  name: 'github',
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: 'secret' },
};

const stdioDefNoArgsEnv: McpServerDef = {
  name: 'bare',
  type: 'stdio',
  command: 'my-server',
};

const httpDef: McpServerDef = {
  name: 'remote-http',
  type: 'http',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer x' },
};

const sseDef: McpServerDef = {
  name: 'remote-sse',
  type: 'sse',
  url: 'https://example.com/sse',
};

describe.each([
  { agent: 'claude' as const, containerKey: 'mcpServers' },
  { agent: 'cursor' as const, containerKey: 'mcpServers' },
  { agent: 'copilot' as const, containerKey: 'servers' },
])('$agent writer (JSON, %s container)', ({ agent, containerKey }) => {
  it('upserts a stdio server into empty text', () => {
    const writer = writerFor(agent);
    const text = writer.upsert('', 'github_1', stdioDef);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed[containerKey]).toEqual({
      github_1: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'secret' },
      },
    });
  });

  it('omits args/env when absent on stdio', () => {
    const writer = writerFor(agent);
    const text = writer.upsert('', 'bare_1', stdioDefNoArgsEnv);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const server = (parsed[containerKey] as Record<string, unknown>)['bare_1'] as Record<
      string,
      unknown
    >;
    expect(server).toEqual({ type: 'stdio', command: 'my-server' });
    expect(server['args']).toBeUndefined();
    expect(server['env']).toBeUndefined();
  });

  it('shapes an http server with type + url + headers', () => {
    const writer = writerFor(agent);
    const text = writer.upsert('', 'remote_http_1', httpDef);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect((parsed[containerKey] as Record<string, unknown>)['remote_http_1']).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('shapes an sse server with type + url, omitting headers when absent', () => {
    const writer = writerFor(agent);
    const text = writer.upsert('', 'remote_sse_1', sseDef);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect((parsed[containerKey] as Record<string, unknown>)['remote_sse_1']).toEqual({
      type: 'sse',
      url: 'https://example.com/sse',
    });
  });

  it('preserves an unrelated user-defined server and other top-level keys', () => {
    const writer = writerFor(agent);
    const existing = JSON.stringify({
      someOtherTopLevelKey: { keep: true },
      [containerKey]: { user_server: { type: 'stdio', command: 'user-defined' } },
    });
    const text = writer.upsert(existing, 'github_1', stdioDef);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['someOtherTopLevelKey']).toEqual({ keep: true });
    expect((parsed[containerKey] as Record<string, unknown>)['user_server']).toEqual({
      type: 'stdio',
      command: 'user-defined',
    });
    expect((parsed[containerKey] as Record<string, unknown>)['github_1']).toBeDefined();
  });

  it('remove drops only the named server, leaving others intact', () => {
    const writer = writerFor(agent);
    const withTwo = writer.upsert(writer.upsert('', 'github_1', stdioDef), 'other_1', httpDef);
    const text = writer.remove(withTwo, 'github_1');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const container = parsed[containerKey] as Record<string, unknown>;
    expect(container['github_1']).toBeUndefined();
    expect(container['other_1']).toBeDefined();
  });

  it('remove is a no-op (text unchanged) when the server is absent', () => {
    const writer = writerFor(agent);
    const existing = writer.upsert('', 'github_1', stdioDef);
    expect(writer.remove(existing, 'does_not_exist')).toBe(existing);
    expect(writer.remove('', 'does_not_exist')).toBe('');
  });

  it('existingNames lists every server present in the container', () => {
    const writer = writerFor(agent);
    const withTwo = writer.upsert(writer.upsert('', 'github_1', stdioDef), 'other_1', httpDef);
    expect(writer.existingNames(withTwo).sort()).toEqual(['github_1', 'other_1']);
    expect(writer.existingNames('')).toEqual([]);
  });
});

describe('opencode writer', () => {
  it('maps stdio to a local server with command as [command, ...args] and env as environment', () => {
    const writer = writerFor('opencode');
    const text = writer.upsert('', 'github_1', stdioDef);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect((parsed['mcp'] as Record<string, unknown>)['github_1']).toEqual({
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-github'],
      environment: { GITHUB_TOKEN: 'secret' },
      enabled: true,
    });
  });

  it('omits environment when env is absent, and command has no extra args', () => {
    const writer = writerFor('opencode');
    const text = writer.upsert('', 'bare_1', stdioDefNoArgsEnv);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const server = (parsed['mcp'] as Record<string, unknown>)['bare_1'] as Record<string, unknown>;
    expect(server).toEqual({ type: 'local', command: ['my-server'], enabled: true });
  });

  it('maps both http and sse to a remote server', () => {
    const writer = writerFor('opencode');
    const httpText = writer.upsert('', 'remote_http_1', httpDef);
    const sseText = writer.upsert('', 'remote_sse_1', sseDef);
    const httpParsed = JSON.parse(httpText) as Record<string, unknown>;
    const sseParsed = JSON.parse(sseText) as Record<string, unknown>;
    expect((httpParsed['mcp'] as Record<string, unknown>)['remote_http_1']).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      enabled: true,
    });
    expect((sseParsed['mcp'] as Record<string, unknown>)['remote_sse_1']).toEqual({
      type: 'remote',
      url: 'https://example.com/sse',
      enabled: true,
    });
  });

  it('preserves an unrelated user-defined server and other top-level keys', () => {
    const writer = writerFor('opencode');
    const existing = JSON.stringify({
      theme: 'dark',
      mcp: { user_server: { type: 'remote', url: 'https://user.example', enabled: true } },
    });
    const text = writer.upsert(existing, 'github_1', stdioDef);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['theme']).toBe('dark');
    expect((parsed['mcp'] as Record<string, unknown>)['user_server']).toEqual({
      type: 'remote',
      url: 'https://user.example',
      enabled: true,
    });
  });

  it('remove drops only the named server (no-op if absent) and existingNames lists all', () => {
    const writer = writerFor('opencode');
    const withTwo = writer.upsert(writer.upsert('', 'github_1', stdioDef), 'other_1', httpDef);
    expect(writer.existingNames(withTwo).sort()).toEqual(['github_1', 'other_1']);

    const removed = writer.remove(withTwo, 'github_1');
    const parsed = JSON.parse(removed) as Record<string, unknown>;
    const container = parsed['mcp'] as Record<string, unknown>;
    expect(container['github_1']).toBeUndefined();
    expect(container['other_1']).toBeDefined();

    expect(writer.remove(removed, 'does_not_exist')).toBe(removed);
    expect(writer.remove('', 'does_not_exist')).toBe('');
  });
});

describe('codex writer (TOML)', () => {
  it('round-trips a stdio server through upsert', () => {
    const writer = writerFor('codex');
    const text = writer.upsert('', 'github_1', stdioDef);
    expect(text).toContain('[mcp_servers.github_1]');
    expect(writer.existingNames(text)).toEqual(['github_1']);

    // Re-parsing the produced TOML recovers the same server definition.
    const again = writer.upsert(text, 'github_1', stdioDef);
    expect(again).toBe(text);
  });

  it('omits args/env when absent', () => {
    const writer = writerFor('codex');
    const text = writer.upsert('', 'bare_1', stdioDefNoArgsEnv);
    expect(text).not.toContain('args');
    expect(text).not.toContain('env');
  });

  it('preserves an unrelated user-defined server and other top-level tables', () => {
    const writer = writerFor('codex');
    const existing = [
      '[model]',
      'name = "gpt-5"',
      '',
      '[mcp_servers.user_server]',
      'command = "user-defined"',
      '',
    ].join('\n');
    const text = writer.upsert(existing, 'github_1', stdioDef);
    expect(text).toContain('[model]');
    expect(text).toContain('name = "gpt-5"');
    expect(text).toContain('[mcp_servers.user_server]');
    expect(text).toContain('command = "user-defined"');
    expect(text).toContain('[mcp_servers.github_1]');
  });

  it('remove drops only the named server (no-op if absent)', () => {
    const writer = writerFor('codex');
    const withTwo = writer.upsert(
      writer.upsert('', 'github_1', stdioDef),
      'other_1',
      stdioDefNoArgsEnv,
    );
    const removed = writer.remove(withTwo, 'github_1');
    expect(removed).not.toContain('[mcp_servers.github_1]');
    expect(removed).toContain('[mcp_servers.other_1]');

    expect(writer.remove(removed, 'does_not_exist')).toBe(removed);
    expect(writer.remove('', 'does_not_exist')).toBe('');
  });

  it('existingNames lists every server present', () => {
    const writer = writerFor('codex');
    const withTwo = writer.upsert(
      writer.upsert('', 'github_1', stdioDef),
      'other_1',
      stdioDefNoArgsEnv,
    );
    expect(writer.existingNames(withTwo).sort()).toEqual(['github_1', 'other_1']);
    expect(writer.existingNames('')).toEqual([]);
  });

  it('rejects a non-stdio def', () => {
    const writer = writerFor('codex');
    expect(() => writer.upsert('', 'remote_http_1', httpDef)).toThrow();
  });
});

describe('defensive validation (malformed def / malformed file)', () => {
  it('json writers reject a stdio def with no command', () => {
    const writer = writerFor('claude');
    expect(() => writer.upsert('', 'x', { name: 'x', type: 'stdio' })).toThrow();
  });

  it('json writers reject an http/sse def with no url', () => {
    const writer = writerFor('opencode');
    expect(() => writer.upsert('', 'x', { name: 'x', type: 'http' })).toThrow();
  });

  it('json writers reject a non-object JSON root', () => {
    const writer = writerFor('claude');
    expect(() => writer.upsert('[]', 'x', stdioDef)).toThrow();
    expect(() => writer.existingNames('[]')).toThrow();
  });

  it('codex writer rejects a stdio def with no command', () => {
    const writer = writerFor('codex');
    expect(() => writer.upsert('', 'x', { name: 'x', type: 'stdio' })).toThrow();
  });
});

describe('supportsTransport', () => {
  it('codex supports stdio only', () => {
    expect(supportsTransport('codex', 'stdio')).toBe(true);
    expect(supportsTransport('codex', 'http')).toBe(false);
    expect(supportsTransport('codex', 'sse')).toBe(false);
  });

  it('every other agent supports all three transports', () => {
    for (const agent of ['claude', 'cursor', 'copilot', 'opencode'] as const) {
      expect(supportsTransport(agent, 'stdio')).toBe(true);
      expect(supportsTransport(agent, 'http')).toBe(true);
      expect(supportsTransport(agent, 'sse')).toBe(true);
    }
  });
});

describe('mcpDestination', () => {
  it('resolves project-scoped paths per agent', () => {
    const target = { projectPath: '/proj', homeDir: '/home/user' };
    expect(mcpDestination('claude', target)).toEqual({ path: '/proj/.mcp.json', scope: 'project' });
    expect(mcpDestination('cursor', target)).toEqual({
      path: '/proj/.cursor/mcp.json',
      scope: 'project',
    });
    expect(mcpDestination('copilot', target)).toEqual({
      path: '/proj/.vscode/mcp.json',
      scope: 'project',
    });
    expect(mcpDestination('opencode', target)).toEqual({
      path: '/proj/opencode.json',
      scope: 'project',
    });
  });

  it('resolves codex globally, under homeDir, ignoring projectPath', () => {
    const target = { projectPath: '/proj', homeDir: '/home/user' };
    expect(mcpDestination('codex', target)).toEqual({
      path: '/home/user/.codex/config.toml',
      scope: 'global',
    });
  });

  it('throws when a required target field is missing', () => {
    expect(() => mcpDestination('claude', {})).toThrow();
    expect(() => mcpDestination('codex', {})).toThrow();
  });
});
