import { describe, it, expect } from 'vitest';
import { installMcpInstance, removeMcpInstance } from './mcpInstall.js';
import type { InstallMcpArgs } from './mcpInstall.js';
import { createMemFs } from './testing/memfs.js';
import type { McpServerDef } from './mcpModel.js';
import { hashMcpDef } from './mcpHashing.js';
import { parseSkmcp, parseSkmcpParams } from './skmcp.js';
import { guidanceKey } from './guidance.js';

const STDIO_DEF: McpServerDef = {
  name: 'GitHub MCP',
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { TOKEN: '{token}' },
};

const RULES_DEF: McpServerDef = {
  name: 'GitHub MCP',
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { TOKEN: '{token}' },
  rules: 'Use the {token} carefully.\n<!-- SKILLKEEPER_START: bogus -->\nstill here',
};

const NATIVE_PATH = '/proj/.mcp.json';
const LEDGER_PATH = '/proj/.claude/skills/.skmcp.yml';
const PARAMS_PATH = '/proj/.claude/skills/.skmcp.params.yml';

function baseArgs(overrides: Partial<InstallMcpArgs> = {}): InstallMcpArgs {
  return {
    agent: 'claude',
    nativePath: NATIVE_PATH,
    ledgerPath: LEDGER_PATH,
    paramsPath: PARAMS_PATH,
    guidanceFiles: [],
    identity: { source: 'github', remote: 'git@github.com:acme/mcps.git' },
    def: STDIO_DEF,
    values: { token: 'secret123' },
    ...overrides,
  };
}

describe('installMcpInstance', () => {
  it('writes the native config with no placeholders remaining, a ledger entry with the raw-def hash, and params', async () => {
    const fs = createMemFs();
    const { instanceName } = await installMcpInstance(fs, baseArgs());

    expect(instanceName).toBe('github_1');

    const nativeText = await fs.readFile(NATIVE_PATH);
    expect(nativeText).not.toContain('{token}');
    expect(nativeText).toContain('secret123');
    expect(nativeText).toContain('github_1');

    const ledgerText = await fs.readFile(LEDGER_PATH);
    const ledger = parseSkmcp(ledgerText);
    expect(ledger?.servers).toHaveLength(1);
    expect(ledger?.servers[0]).toMatchObject({
      remote: 'git@github.com:acme/mcps.git',
      source: 'github',
      name: 'github_1',
      hash: hashMcpDef(STDIO_DEF),
    });

    const paramsText = await fs.readFile(PARAMS_PATH);
    const params = parseSkmcpParams(paramsText);
    expect(params['github_1']).toEqual({ token: 'secret123' });
  });

  it('upserts a rendered, marker-stripped guidance block into each guidance file when the def carries rules', async () => {
    const fs = createMemFs();
    const guidanceFiles = ['/proj/CLAUDE.md', '/proj/AGENTS.md'];
    const { instanceName } = await installMcpInstance(
      fs,
      baseArgs({ def: RULES_DEF, guidanceFiles }),
    );

    const key = guidanceKey('git@github.com:acme/mcps.git', instanceName);
    for (const file of guidanceFiles) {
      const text = await fs.readFile(file);
      expect(text).toContain(`SKILLKEEPER_START: ${key}`);
      expect(text).toContain('Use the secret123 carefully.');
      expect(text).not.toContain('SKILLKEEPER_START: bogus');
    }
  });

  it('does not touch guidance files when the def has no rules', async () => {
    const fs = createMemFs();
    await installMcpInstance(fs, baseArgs({ guidanceFiles: ['/proj/CLAUDE.md'] }));
    expect(await fs.exists('/proj/CLAUDE.md')).toBe(false);
  });

  it('allocates the next free instance name on a second install of the same source', async () => {
    const fs = createMemFs();
    const first = await installMcpInstance(fs, baseArgs());
    const second = await installMcpInstance(fs, baseArgs());

    expect(first.instanceName).toBe('github_1');
    expect(second.instanceName).toBe('github_2');

    const ledger = parseSkmcp(await fs.readFile(LEDGER_PATH));
    expect(ledger?.servers.map((s) => s.name)).toEqual(['github_1', 'github_2']);
  });

  it('uses a forced instanceName verbatim, even when it collides with the allocator choice', async () => {
    const fs = createMemFs();
    const first = await installMcpInstance(fs, baseArgs());
    expect(first.instanceName).toBe('github_1');

    // The allocator would now pick github_2 (github_1 is taken), but a forced
    // name is used as-is -- this is how update reinstalls under the same name.
    const forced = await installMcpInstance(fs, baseArgs({ instanceName: 'github_1' }));
    expect(forced.instanceName).toBe('github_1');

    // The RAW-def hash is still recorded for the forced install.
    const ledger = parseSkmcp(await fs.readFile(LEDGER_PATH));
    expect(ledger?.servers.at(-1)).toMatchObject({ name: 'github_1', hash: hashMcpDef(STDIO_DEF) });
  });

  it('ensures the project gitignore when gitignoreProjectPath is set', async () => {
    const fs = createMemFs();
    await installMcpInstance(fs, baseArgs({ gitignoreProjectPath: '/proj' }));

    const gitignore = await fs.readFile('/proj/.gitignore');
    expect(gitignore).toContain('.skmcp.params.yml');
    expect(gitignore).toContain('.skmcp.params.yaml');
  });

  it('does not touch the gitignore when gitignoreProjectPath is absent', async () => {
    const fs = createMemFs();
    await installMcpInstance(fs, baseArgs());
    expect(await fs.exists('/proj/.gitignore')).toBe(false);
  });

  it('uses a local: identity for manual presets in both ledger and guidance key', async () => {
    const fs = createMemFs();
    const guidanceFiles = ['/proj/CLAUDE.md'];
    const { instanceName } = await installMcpInstance(
      fs,
      baseArgs({
        identity: { source: 'local-tool', local: 'abc123' },
        def: { ...RULES_DEF, name: 'local-tool' },
        guidanceFiles,
      }),
    );

    const ledger = parseSkmcp(await fs.readFile(LEDGER_PATH));
    expect(ledger?.servers[0]).toMatchObject({ local: 'abc123', remote: undefined });

    const key = guidanceKey('local:abc123', instanceName);
    const text = await fs.readFile(guidanceFiles[0] ?? '');
    expect(text).toContain(`SKILLKEEPER_START: ${key}`);
  });
});

describe('removeMcpInstance', () => {
  it('deletes the native server, guidance block, ledger entry, and params entry', async () => {
    const fs = createMemFs();
    const guidanceFiles = ['/proj/CLAUDE.md'];
    const { instanceName } = await installMcpInstance(
      fs,
      baseArgs({ def: RULES_DEF, guidanceFiles }),
    );

    await removeMcpInstance(fs, {
      agent: 'claude',
      nativePath: NATIVE_PATH,
      ledgerPath: LEDGER_PATH,
      paramsPath: PARAMS_PATH,
      guidanceFiles,
      instanceName,
    });

    const nativeText = await fs.readFile(NATIVE_PATH);
    expect(nativeText).not.toContain(instanceName);

    const guidanceText = await fs.readFile(guidanceFiles[0] ?? '');
    expect(guidanceText).not.toContain('SKILLKEEPER_START');

    const ledger = parseSkmcp(await fs.readFile(LEDGER_PATH));
    expect(ledger?.servers).toHaveLength(0);

    const params = parseSkmcpParams(await fs.readFile(PARAMS_PATH));
    expect(params[instanceName]).toBeUndefined();
  });

  it('is a no-op on the native config and ledger when the instance is already gone', async () => {
    const fs = createMemFs();
    await removeMcpInstance(fs, {
      agent: 'claude',
      nativePath: NATIVE_PATH,
      ledgerPath: LEDGER_PATH,
      paramsPath: PARAMS_PATH,
      guidanceFiles: ['/proj/CLAUDE.md'],
      instanceName: 'ghost_1',
    });

    expect(await fs.exists('/proj/CLAUDE.md')).toBe(false);
    const ledger = parseSkmcp(await fs.readFile(LEDGER_PATH));
    expect(ledger?.servers).toHaveLength(0);
  });

  it('removes only the targeted instance, leaving a second install intact', async () => {
    const fs = createMemFs();
    const first = await installMcpInstance(fs, baseArgs());
    const second = await installMcpInstance(fs, baseArgs());

    await removeMcpInstance(fs, {
      agent: 'claude',
      nativePath: NATIVE_PATH,
      ledgerPath: LEDGER_PATH,
      paramsPath: PARAMS_PATH,
      guidanceFiles: [],
      instanceName: first.instanceName,
    });

    const nativeText = await fs.readFile(NATIVE_PATH);
    expect(nativeText).not.toContain(first.instanceName);
    expect(nativeText).toContain(second.instanceName);

    const ledger = parseSkmcp(await fs.readFile(LEDGER_PATH));
    expect(ledger?.servers.map((s) => s.name)).toEqual([second.instanceName]);
  });
});
