/**
 * MCP presets end to end: discovery (including the group-scoped file), parameter
 * substitution, the two ledger files, the .gitignore guard for the secrets file,
 * rules rendered into guidance, and the Codex stdio-only skip.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { read, readJson, Sandbox } from '../src/cli';

describe('mcp', () => {
  let sandbox: Sandbox;
  let project: string;

  beforeAll(() => {
    sandbox = new Sandbox();
    sandbox.addFixtureRepo();
    project = sandbox.project();
  });

  afterAll(() => sandbox.cleanup());

  it('discovers the root presets and the group-scoped one', () => {
    const listed = sandbox.runOk(['mcp', 'list']).stdout;
    for (const name of [
      'filesystem',
      'github',
      'bare-stdio',
      'docs-http',
      'events-sse',
      'oauth-http',
      'oauth-stdio-invalid',
      'docs-linked',
      'docs-invalid',
    ]) {
      expect(listed).toContain(name);
    }
    // Load-bearing: a group's mcp.yml is only found when that group holds at
    // least one *resolvable* skill, so this failing points at group resolution
    // rather than at MCP parsing.
    expect(listed).toContain('tooling/tooling-registry');
    // Discovery walks EVERY ancestor directory of a resolved skill, not just the
    // first path segment, so a preset's group is the full directory path.
    expect(listed).toContain('platform/lint/lint-registry');
    expect(listed).toContain('platform/lint/rust/rust-registry');
    // Counted separately, because one total folded the preset count and the
    // number of presets carrying a description into a single number: adding a
    // description to an existing preset then looked exactly like adding a
    // preset. A preset line is the one naming its origin; a description is an
    // indented continuation of the line above it.
    const lines = listed.trim().split('\n');
    const presetLines = lines.filter((l) => l.includes('origin='));
    const describedLines = lines.filter((l) => !l.includes('origin='));
    expect(presetLines).toHaveLength(12);
    // docs-linked and docs-invalid are the two that carry a `description`.
    expect(describedLines).toHaveLength(2);
    expect(describedLines.every((l) => l.startsWith('    '))).toBe(true);
  });

  describe('install', () => {
    beforeAll(() => {
      sandbox.runOk([
        'mcp',
        'install',
        'docs-http',
        '--agent',
        'claude',
        '--project',
        project,
        '--param',
        'host=docs.example.com',
        '--param',
        'token=sk-test',
      ]);
      sandbox.runOk(['mcp', 'install', 'bare-stdio', '--agent', 'claude', '--project', project]);
      sandbox.runOk([
        'mcp',
        'install',
        'tooling/tooling-registry',
        '--agent',
        'claude',
        '--project',
        project,
        '--param',
        'profile=ci',
        '--param',
        'registry_url=https://reg.example.com',
      ]);
    });

    it('renders parameters into url, headers, args, and env', () => {
      const native = readJson<{
        mcpServers: Record<string, Record<string, unknown>>;
      }>(join(project, '.mcp.json'));
      const http = native.mcpServers['docs_http_1'];
      expect(http?.['url']).toBe('https://docs.example.com/mcp');
      expect((http?.['headers'] as Record<string, string>)['Authorization']).toBe('Bearer sk-test');

      const registry = native.mcpServers['tooling_registry_1'];
      expect(registry?.['args']).toEqual(['-y', '@skillkeeper-test/registry-mcp', '--profile', 'ci']);
      expect((registry?.['env'] as Record<string, string>)['REGISTRY_URL']).toBe('https://reg.example.com');
    });

    it('leaves a parameterless preset with no args or env', () => {
      const native = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(join(project, '.mcp.json'));
      const bare = native.mcpServers['bare_stdio_1'];
      expect(bare?.['command']).toBe('skillkeeper-test-mcp');
      expect(bare?.['args']).toBeUndefined();
      expect(bare?.['env']).toBeUndefined();
    });

    it('records each instance in the ledger, with the group only where it applies', () => {
      const ledger = read(join(project, '.claude', 'skills', '.skmcp.yml'));
      expect(ledger).toContain('source: docs-http');
      expect(ledger).toContain('name: docs_http_1');
      expect(ledger).toMatch(/hash: sha256:[0-9a-f]{64}/);
      expect(ledger).toContain('group: tooling');
      // The two ungrouped presets must not gain a group field.
      expect(ledger.match(/group:/g) ?? []).toHaveLength(1);
    });

    it('writes raw parameter values separately, with an empty map for none', () => {
      const params = read(join(project, '.claude', 'skills', '.skmcp.params.yml'));
      expect(params).toContain('host: docs.example.com');
      expect(params).toContain('token: sk-test');
      expect(params).toContain('bare_stdio_1: {}');
    });

    it('gitignores the parameter files, which hold secrets verbatim', () => {
      const ignore = read(join(project, '.gitignore'));
      expect(ignore).toContain('.skmcp.params.yml');
      expect(ignore).toContain('.skmcp.params.yaml');
    });

    it('renders rules into the guidance file with parameters substituted', () => {
      const guidance = read(join(project, '.claude', 'CLAUDE.md'));
      expect(guidance).toContain('docs.example.com');
      expect(guidance).toContain('ci profile');
      expect(guidance).toContain('https://reg.example.com');
      // No placeholder may survive rendering.
      expect(guidance).not.toContain('{host}');
      expect(guidance).not.toContain('{profile}');
      expect(guidance).not.toContain('{registry_url}');
    });

    it('allocates a new instance name when the same preset is installed twice', () => {
      sandbox.runOk(['mcp', 'install', 'bare-stdio', '--agent', 'claude', '--project', project]);
      const native = readJson<{ mcpServers: Record<string, unknown> }>(join(project, '.mcp.json'));
      expect(Object.keys(native.mcpServers)).toContain('bare_stdio_2');
    });
  });

  it('skips a non-stdio preset for codex instead of writing a broken config', () => {
    const result = sandbox.run([
      'mcp',
      'install',
      'events-sse',
      '--agent',
      'codex',
      '--project',
      project,
      '--param',
      'host=x.example.com',
    ]);
    // Codex cannot express sse natively, so it is skipped rather than attempted.
    // The command still exits non-zero: nothing was installed, and a caller
    // asking for an install deserves to hear that it did not happen.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Skipped codex');
    expect(result.stdout).toContain('sse');
    // A mistaken write could now land at EITHER scope: codex takes a project
    // config as of this branch, so checking only HOME would miss the more
    // likely of the two. Neither may appear.
    expect(existsSync(join(sandbox.home, '.codex', 'config.toml'))).toBe(false);
    expect(existsSync(join(project, '.codex', 'config.toml'))).toBe(false);
  });

  it('removes an instance from the native config and both ledgers', () => {
    sandbox.runOk(['mcp', 'remove', 'docs_http_1', '--agent', 'claude', '--project', project]);
    const native = readJson<{ mcpServers: Record<string, unknown> }>(join(project, '.mcp.json'));
    expect(Object.keys(native.mcpServers)).not.toContain('docs_http_1');
    const ledger = read(join(project, '.claude', 'skills', '.skmcp.yml'));
    expect(ledger).not.toContain('name: docs_http_1');
    expect(read(join(project, '.claude', 'skills', '.skmcp.params.yml'))).not.toContain('docs_http_1:');
    // Its guidance block goes with it; the other preset's block stays.
    const guidance = read(join(project, '.claude', 'CLAUDE.md'));
    expect(guidance).not.toContain('docs.example.com');
    expect(guidance).toContain('https://reg.example.com');
  });

  describe('global scope', () => {
    it('installs into the home config and the global ledger', () => {
      sandbox.runOk(['mcp', 'install', 'bare-stdio', '--agent', 'claude', '--global']);

      const native = readJson<{ mcpServers: Record<string, unknown> }>(join(sandbox.home, '.claude.json'));
      expect(Object.keys(native.mcpServers)).toHaveLength(1);
      expect(read(join(sandbox.home, '.claude', 'skills', '.skmcp.yml'))).toContain('bare-stdio');
      // No project file is touched at global scope. A fresh directory is used
      // here (rather than the suite's shared `project`) because that one
      // already carries a `.mcp.json` from the project-scope installs earlier
      // in this file, which would make the assertion pass or fail for the
      // wrong reason.
      const untouched = sandbox.project('untouched-by-global');
      expect(existsSync(join(untouched, '.mcp.json'))).toBe(false);
    });

    // Runs after the install test above and reverses it: the global scope has
    // to be as removable as a project's, or a user-wide server can only be
    // uninstalled by editing the agent's config by hand.
    it('removes at the same scope, leaving no native entry and no ledger entry', () => {
      // The same preset installed into a project of its own, so this test can
      // show the global remove staying out of a project's ledger without
      // depending on the project-scope suite above having run.
      const shadowed = sandbox.project('shadowed-by-global');
      sandbox.runOk(['mcp', 'install', 'bare-stdio', '--agent', 'claude', '--project', shadowed]);

      sandbox.runOk(['mcp', 'remove', 'bare_stdio_1', '--agent', 'claude', '--global']);

      const native = readJson<{ mcpServers: Record<string, unknown> }>(join(sandbox.home, '.claude.json'));
      expect(Object.keys(native.mcpServers)).toHaveLength(0);
      const ledgerDir = join(sandbox.home, '.claude', 'skills');
      expect(read(join(ledgerDir, '.skmcp.yml'))).not.toContain('bare_stdio_1');
      expect(read(join(ledgerDir, '.skmcp.params.yml'))).not.toContain('bare_stdio_1');
      // The two scopes' ledgers are separate files: the project instance stays.
      expect(read(join(shadowed, '.claude', 'skills', '.skmcp.yml'))).toContain('bare_stdio_1');
    });

    it('reports a missing instance at global scope instead of failing silently', () => {
      const res = sandbox.run(['mcp', 'remove', 'bare_stdio_1', '--agent', 'claude', '--global']);
      expect(res.status).toBe(1);
      expect(res.output).toContain('bare_stdio_1');
    });

    it('refuses --global together with --project', () => {
      const res = sandbox.run(['mcp', 'install', 'bare-stdio', '--agent', 'claude', '--global', '--project', project]);
      expect(res.status).not.toBe(0);
      expect(res.output).toContain('--project');
    });

    it('installs a project-scoped config for codex instead of refusing', () => {
      // Codex used to be coerced to global scope no matter what was asked; a
      // project-scoped install now lands in the project's own
      // .codex/config.toml, not the refusal this used to print.
      const res = sandbox.runOk(['mcp', 'install', 'bare-stdio', '--agent', 'codex', '--project', project]);
      expect(res.stdout).toContain('(codex) ->');
      expect(existsSync(join(project, '.codex', 'config.toml'))).toBe(true);
      // Nothing was written to the user-wide config.
      expect(existsSync(join(sandbox.home, '.codex', 'config.toml'))).toBe(false);
    });
  });
});
