/**
 * MCP descriptions and options end to end: link rendering, description
 * truncation, option-value validation on install, and the SK018/SK019 lint
 * warnings. Model of `e2e/tests/mcp.spec.ts`; reuses the same fixture and
 * harness rather than building a second one.
 *
 * The fixtures this exercises are `docs-linked` (a linked description plus a
 * described, option-constrained parameter) and `docs-invalid` (an over-long
 * description and a `parameters` entry no placeholder uses), both in the
 * fixture's root `mcp.yml` -- see its README's "MCP presets" section.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIR, readJson, Sandbox } from '../src/cli';

/** One `repo lint --json` item; only the fields this spec reads. */
interface LintItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
}

describe('mcp descriptions and options', () => {
  let sandbox: Sandbox;
  let project: string;

  beforeAll(() => {
    sandbox = new Sandbox();
    sandbox.addFixtureRepo();
    project = sandbox.project();
  });

  afterAll(() => sandbox.cleanup());

  it('prints a link as its text followed by its url in parentheses', () => {
    const listed = sandbox.runOk(['mcp', 'list']).stdout;
    // The description's own "{host}" mention is prose, never scanned for
    // placeholders, so it reaches the terminal literally -- unlike the real
    // {host} parameter substituted into docs-linked's url on install below.
    expect(listed).toContain(
      'See reference (https://docs.example.com/reference) for {host} usage notes.',
    );
  });

  it('truncates an over-long description to 128 visible characters, marked with an ellipsis', () => {
    const listed = sandbox.runOk(['mcp', 'list']).stdout;
    const line = listed
      .split('\n')
      .find((l) => l.trim().startsWith('This description exists only'));
    expect(line).toBeDefined();
    const text = (line ?? '').trim();
    expect(text.endsWith('...')).toBe(true);
    // The full description is well past the budget; only the first 128
    // visible characters survive, plus the ellipsis marker.
    expect(text.length - '...'.length).toBe(128);
  });

  describe('install', () => {
    it('accepts a value that is one of the parameter options', () => {
      const result = sandbox.runOk([
        'mcp', 'install', 'docs-linked', '--agent', 'claude', '--project', project,
        '--param', 'host=docs.example.com', '--param', 'access=read',
      ]);
      expect(result.stdout).toContain('Installed: docs_linked_1 (claude) ->');
      const native = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(
        join(project, '.mcp.json'),
      );
      const server = native.mcpServers['docs_linked_1'];
      expect(server?.['url']).toBe('https://docs.example.com/docs');
      expect((server?.['headers'] as Record<string, string>)['X-Access-Level']).toBe('read');
    });

    it('refuses a value outside the options, exits 1, names the accepted ones, and writes nothing', () => {
      const freshProject = sandbox.project('invalid-option');
      const result = sandbox.run([
        'mcp', 'install', 'docs-linked', '--agent', 'claude', '--project', freshProject,
        '--param', 'host=docs.example.com', '--param', 'access=admin',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('access');
      expect(result.stderr).toContain('read');
      expect(result.stderr).toContain('write');
      // A refusal is not a partial install: nothing was written for this
      // project at all.
      expect(existsSync(join(freshProject, '.mcp.json'))).toBe(false);
    });
  });

  it('reports SK018 and SK019 as warnings', () => {
    // The fixture also ships pre-existing SK001-SK005 errors unrelated to MCP
    // (see check-fixture-repo's notes), so `repo lint` on this path exits 1
    // regardless of these two codes. That is not what this test checks: it
    // checks that SK018 and SK019 fire, and fire as warnings, not that a
    // warning alone would fail the run -- `repo lint` fails only on an error.
    const result = sandbox.run(['repo', 'lint', '--path', FIXTURE_DIR, '--json']);
    const items = JSON.parse(result.stdout) as LintItem[];
    const sk018 = items.find((d) => d.code === 'SK018');
    const sk019 = items.find((d) => d.code === 'SK019');
    expect(sk018?.severity).toBe('warning');
    expect(sk019?.severity).toBe('warning');
  });
});
