/**
 * MCP oauth end to end: install the fixture's `oauth-http` preset for every
 * agent and assert each native file's exact shape (see docs/usage/mcp.md's
 * "Per-agent rendering" table), assert copilot is skipped outright, assert no
 * agent's config ever carries a client secret, and assert `repo lint` reports
 * the fixture's deliberately invalid `oauth-stdio-invalid` preset as a
 * warning without stopping the rest of the repository from resolving.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { read, readJson, Sandbox } from '../src/cli';

describe('mcp oauth', () => {
  let sandbox: Sandbox;
  let fixtureClone: string;
  let project: string;
  let installOutput: string;

  beforeAll(() => {
    sandbox = new Sandbox();
    fixtureClone = sandbox.addFixtureRepo();
    project = sandbox.project();
    installOutput = sandbox.runOk([
      'mcp', 'install', 'oauth-http',
      '--agent', 'claude,cursor,codex,opencode,copilot',
      '--project', project,
    ]).stdout;
  });

  afterAll(() => sandbox.cleanup());

  it('claude: an oauth object with clientId, callbackPort, and space-joined scopes', () => {
    expect(installOutput).toContain('Installed: oauth_http_1 (claude) ->');
    const native = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(
      join(project, '.mcp.json'),
    );
    const oauth = native.mcpServers['oauth_http_1']?.['oauth'] as Record<string, unknown>;
    expect(oauth['clientId']).toBe('example-client');
    expect(oauth['callbackPort']).toBe(8432);
    // A single space-separated string, not an array: RFC 6749 section 3.3.
    expect(oauth['scopes']).toBe('read write');
  });

  it('cursor: an auth object with CLIENT_ID and an array of scopes; the callback port is dropped and reported', () => {
    expect(installOutput).toContain('Installed: oauth_http_1 (cursor) ->');
    expect(installOutput).toContain('Note cursor: cannot express "callbackPort"; it was not written.');
    const native = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(
      join(project, '.cursor', 'mcp.json'),
    );
    const auth = native.mcpServers['oauth_http_1']?.['auth'] as Record<string, unknown>;
    expect(auth['CLIENT_ID']).toBe('example-client');
    expect(auth['scopes']).toEqual(['read', 'write']);
    expect(auth['callbackPort']).toBeUndefined();
    expect(auth['CLIENT_SECRET']).toBeUndefined();
  });

  it('opencode: an oauth object with only clientId; the callback port and scopes are both dropped and reported', () => {
    expect(installOutput).toContain('Installed: oauth_http_1 (opencode) ->');
    expect(installOutput).toContain('Note opencode: cannot express "callbackPort"; it was not written.');
    expect(installOutput).toContain('Note opencode: cannot express "scopes"; it was not written.');
    const native = readJson<{ mcp: Record<string, Record<string, unknown>> }>(
      join(project, 'opencode.json'),
    );
    const oauth = native.mcp['oauth_http_1']?.['oauth'] as Record<string, unknown>;
    expect(Object.keys(oauth)).toEqual(['clientId']);
    expect(oauth['clientId']).toBe('example-client');
  });

  it('codex: client_id nested under oauth, scopes beside url (not inside oauth), plus the callback pair', () => {
    expect(installOutput).toContain('Installed: oauth_http_1 (codex) ->');
    const native = read(join(project, '.codex', 'config.toml'));
    expect(native).toContain('[mcp_servers.oauth_http_1]');
    expect(native).toContain('url = "https://mcp.example.com/mcp"');
    expect(native).toContain('scopes = ["read", "write"]');
    expect(native).toContain('[mcp_servers.oauth_http_1.oauth]');
    expect(native).toContain('client_id = "example-client"');
    // The nested oauth table carries client_id alone -- scopes sits in the
    // server table above it, never duplicated into this one.
    const oauthTable = native.split('[mcp_servers.oauth_http_1.oauth]')[1];
    expect(oauthTable).toBeDefined();
    expect(oauthTable).not.toContain('scopes');
    // The two global callback keys, derived from the one port.
    expect(native).toContain('mcp_oauth_callback_port = 8432');
    expect(native).toContain('mcp_oauth_callback_url = "http://localhost:8432/callback"');
  });

  it('codex: also installs at user scope, independent of the project install', () => {
    const result = sandbox.runOk(['mcp', 'install', 'oauth-http', '--agent', 'codex', '--global']);
    expect(result.stdout).toContain('Installed: oauth_http_1 (codex) ->');
    const native = read(join(sandbox.home, '.codex', 'config.toml'));
    expect(native).toContain('[mcp_servers.oauth_http_1]');
    expect(native).toContain('client_id = "example-client"');
    expect(native).toContain('mcp_oauth_callback_port = 8432');
  });

  it('copilot: skipped entirely, with a reason, and no file is written', () => {
    expect(installOutput).toContain('Skipped copilot: cannot express an oauth client.');
    expect(existsSync(join(project, '.vscode', 'mcp.json'))).toBe(false);
  });

  it('never writes a client secret, in any form, for any agent', () => {
    const natives = [
      read(join(project, '.mcp.json')),
      read(join(project, '.cursor', 'mcp.json')),
      read(join(project, 'opencode.json')),
      read(join(project, '.codex', 'config.toml')),
    ];
    for (const text of natives) {
      expect(text.toLowerCase()).not.toContain('secret');
    }
  });

  describe('lint', () => {
    it('reports the oauth-on-stdio preset as a warning without stopping the rest of the repository from resolving', () => {
      const result = sandbox.run(['repo', 'lint', '--path', fixtureClone]);
      // The fixture already carries five unrelated errors (see its README's
      // "Skill dependencies" section), so this exits 1 regardless of the new
      // warning -- SK015 being a warning rather than an error is the point
      // this test pins down, not the exit code by itself.
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/warning SK015.*oauth-stdio-invalid/);

      // The malformed preset does not stop discovery of anything else.
      const listed = sandbox.runOk(['mcp', 'list']).stdout;
      expect(listed).toContain('oauth-http');
      expect(listed).toContain('oauth-stdio-invalid');
      expect(listed).toContain('filesystem');
    });
  });
});
