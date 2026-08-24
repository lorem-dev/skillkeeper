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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIR, read, readJson, Sandbox } from '../src/cli';

/** One `repo lint --json` item; only the fields this spec reads. */
interface LintItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
}

describe('mcp descriptions and options', () => {
  let sandbox: Sandbox;
  let project: string;
  /** The tracked clone the CLI reads presets from; editable, which is how the
   *  update tests below make a source definition change. */
  let clone: string;

  beforeAll(() => {
    sandbox = new Sandbox();
    clone = sandbox.addFixtureRepo();
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

  /**
   * `mcp update`'s option handling, split by where the value came from. The
   * CLI unit tests cover a STORED value going stale; they never cover a
   * user-supplied `--param`, which is exactly where the update path silently
   * substituted what the user typed and then reported the substitution
   * against the stored value.
   *
   * These mutate the tracked clone's `mcp.yml`, so they must stay after
   * everything above that reads the pristine clone. They are NOT last in the
   * file: Jest runs a describe's children in declaration order, so the
   * trailing `it('reports SK018 and SK019 as warnings')` runs after this
   * block. That one is safe because it lints `FIXTURE_DIR` -- the submodule
   * checkout, never written by these tests -- and not the clone. Anything
   * appended after this block that reads the clone must rewrite what it needs
   * or move above it.
   */
  describe('update', () => {
    const CLONE_MCP = (): string => join(clone, 'mcp.yml');
    /** The project whose `docs_linked_1` these tests update. */
    let updateProject: string;

    beforeAll(() => {
      updateProject = sandbox.project('update-options');
      sandbox.runOk([
        'mcp', 'install', 'docs-linked', '--agent', 'claude', '--project', updateProject,
        '--param', 'host=docs.example.com', '--param', 'access=read',
      ]);
    });

    /** Rewrites the clone's `docs-linked` block, which changes the def's hash
     *  and so makes the installed instance out of date -- otherwise `mcp
     *  update` has nothing to do and the option paths are never reached. */
    const rewriteDocsLinked = (optionsBlock: string): void => {
      const text = readFileSync(CLONE_MCP(), 'utf8');
      const start = text.indexOf('  - name: docs-linked');
      const end = text.indexOf('  - name: docs-invalid');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const replacement = [
        '  - name: docs-linked',
        '    type: http',
        '    url: "https://{host}/docs/v2"',
        '    description: "See [reference](https://docs.example.com/reference) for {host} usage notes."',
        '    headers:',
        '      X-Access-Level: "{access}"',
        '    parameters:',
        '      host:',
        '        description: "Docs host to query."',
        '      access:',
        '        description: "Access level to request."',
        optionsBlock,
        '',
        '',
      ].join('\n');
      writeFileSync(CLONE_MCP(), text.slice(0, start) + replacement + text.slice(end));
    };

    const nativeAccess = (): unknown => {
      const native = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(
        join(updateProject, '.mcp.json'),
      );
      const headers = native.mcpServers['docs_linked_1']?.['headers'] as
        | Record<string, string>
        | undefined;
      return headers?.['X-Access-Level'];
    };

    it('refuses a --param outside the options, names the accepted ones, and changes nothing', () => {
      rewriteDocsLinked('        options:\n          read: Read-only\n          write: Read and write');
      const result = sandbox.run([
        'mcp', 'update', 'docs-linked', '--agent', 'claude', '--project', updateProject,
        '--param', 'access=admin',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('admin');
      expect(result.stderr).toContain('read');
      expect(result.stderr).toContain('write');
      // The refusal precedes the remove-then-reinstall, so the instance is
      // still there and still holds what it held.
      expect(nativeAccess()).toBe('read');
      expect(read(join(updateProject, '.claude', 'skills', '.skmcp.params.yml'))).toContain(
        'access: read',
      );
    });

    it('accepts a --param that is one of the options and rewrites the instance', () => {
      const result = sandbox.runOk([
        'mcp', 'update', 'docs-linked', '--agent', 'claude', '--project', updateProject,
        '--param', 'access=write',
      ]);
      expect(result.stdout).toContain('docs_linked_1');
      expect(nativeAccess()).toBe('write');
    });

    it('migrates a stored value the new options no longer offer, and reports it', () => {
      // "write" is now stored (previous test) and is dropped from the source,
      // leaving "read" as the only -- and therefore first -- option. This is
      // a value off disk, so it is migrated and reported rather than refused.
      rewriteDocsLinked('        options:\n          read: Read-only');
      const result = sandbox.runOk([
        'mcp', 'update', 'docs-linked', '--agent', 'claude', '--project', updateProject,
      ]);
      expect(result.stdout).toContain('access');
      expect(result.stdout).toContain('read');
      expect(nativeAccess()).toBe('read');
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
