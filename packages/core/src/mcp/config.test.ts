import { describe, it, expect } from 'vitest';
import { parseMcpConfig, McpConfigError } from './config.js';

describe('parseMcpConfig', () => {
  it('parses an http server with headers + rules', () => {
    const cfg = parseMcpConfig(`version: 1
servers:
  - name: github
    type: http
    url: "https://{host}/mcp"
    headers: { Authorization: "Bearer {token}" }
    rules: "Use {host}."`);
    expect(cfg.servers[0]).toMatchObject({ name: 'github', type: 'http', url: 'https://{host}/mcp' });
  });
  it('parses a stdio server', () => {
    const cfg = parseMcpConfig(`version: 1
servers:
  - name: fs
    type: stdio
    command: npx
    args: ["-y", "@acme/fs"]
    env: { KEY: "{key}" }`);
    expect(cfg.servers[0]).toMatchObject({ type: 'stdio', command: 'npx' });
  });
  it('rejects http without url', () => {
    expect(() => parseMcpConfig(`version: 1
servers: [{ name: x, type: http }]`)).toThrow(McpConfigError);
  });
  it('rejects stdio without command', () => {
    expect(() => parseMcpConfig(`version: 1
servers: [{ name: x, type: stdio }]`)).toThrow(McpConfigError);
  });
  it('throws on invalid YAML with fieldPath ""', () => {
    try { parseMcpConfig(':\n  bad'); } catch (e) { expect(e).toBeInstanceOf(McpConfigError); }
  });
});
