/**
 * Unit tests for the `skillkeeper mcp` command group.
 *
 * Drives the real `registerMcpCommands` wiring against an in-memory `FsPort`
 * (no real network, git, or disk). Covers: list (manual + repo, root +
 * group), install happy path + missing-param + unsupported-transport skip,
 * remove, and update (hash-changed reinstall + missing-param abort).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createMemFs } from '@skillkeeper/core/testing';
import {
  emptyState,
  saveState,
  AdapterRegistry,
  parseSkmcp,
  parseSkmcpParams,
} from '@skillkeeper/core';
import type { Repository } from '@skillkeeper/core';
import { registerBuiltinAgents } from '@skillkeeper/agents';
import type { AdapterHostEnv } from '@skillkeeper/agents';
import { createTranslator } from '@skillkeeper/i18n';
import type { McpPreset } from '@skillkeeper/config';
import { registerMcpCommands } from './mcp.js';

const STATE_PATH = '/state/state.json';
const REPO_PATH = '/repos/mcps';
const HOME = '/home/testuser';
const PROJECT_PATH = '/work/proj';

function makeRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registerBuiltinAgents(registry);
  return registry;
}

const MCP_YML = (serverName: string, opts: { param?: boolean } = {}): string =>
  `version: 1\nservers:\n  - name: ${serverName}\n    type: stdio\n    command: npx\n    args:\n      - ${serverName}${opts.param === true ? '\n      - --key\n      - "{api_key}"' : ''}\n`;

const HTTP_MCP_YML = (serverName: string): string =>
  `version: 1\nservers:\n  - name: ${serverName}\n    type: http\n    url: "https://example.test/${serverName}"\n`;

const SKILL = (name: string): string => `---\nname: ${name}\n---\n# ${name}\n`;

function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'r1',
    name: 'repo-one',
    url: 'git@github.com:acme/mcps.git',
    kind: 'github',
    transport: 'ssh',
    lfs: false,
    localPath: REPO_PATH,
    ...overrides,
  };
}

async function seed(
  files: Record<string, string>,
  repos: Repository[] = [repo()],
): Promise<ReturnType<typeof createMemFs>> {
  const fs = createMemFs(files);
  await saveState(fs, STATE_PATH, { ...emptyState(), repositories: repos });
  return fs;
}

interface Harness {
  readonly fs: ReturnType<typeof createMemFs>;
  readonly program: Command;
  readonly logs: string[];
  readonly errors: string[];
}

function harness(fs: ReturnType<typeof createMemFs>, manualPresets: McpPreset[] = []): Harness {
  const registry = makeRegistry();
  const adapterEnv: AdapterHostEnv = { homeDir: HOME, platform: 'linux', env: {}, fs };
  const t = createTranslator('en');

  const program = new Command('skillkeeper-test').exitOverride();
  registerMcpCommands(program, {
    fs,
    statePath: STATE_PATH,
    registry,
    adapterEnv,
    t,
    manualPresets,
    cwd: () => PROJECT_PATH,
  });

  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  return { fs, program, logs, errors };
}

async function run(program: Command, args: string[]): Promise<void> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  try {
    await program.parseAsync(['node', 'skillkeeper', 'mcp', ...args]);
  } finally {
    exitSpy.mockRestore();
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// mcp list
// ---------------------------------------------------------------------------

describe('mcp list', () => {
  it('lists repo presets (root + group) and manual presets', async () => {
    const fs = await seed({
      [`${REPO_PATH}/mcp.yml`]: MCP_YML('root-server'),
      [`${REPO_PATH}/web/mySkill/SKILL.md`]: SKILL('mySkill'),
      [`${REPO_PATH}/web/mcp.yml`]: MCP_YML('web-server'),
    });
    const manual: McpPreset = {
      id: 'manual-1',
      name: 'manual-server',
      type: 'stdio',
      command: 'npx',
      args: ['manual-server'],
    };
    const { program, logs } = harness(fs, [manual]);

    await run(program, ['list']);

    const text = logs.join('\n');
    expect(text).toContain('root-server');
    expect(text).toContain('web/web-server');
    expect(text).toContain('manual-server');
    expect(text).toContain('origin=manual');
    expect(text).toContain('origin=repo');
  });

  it('prints a message when no presets are available', async () => {
    const fs = await seed({}, []);
    const { program, logs } = harness(fs);

    await run(program, ['list']);

    expect(logs.join('\n')).toContain('No MCP presets available.');
  });
});

// ---------------------------------------------------------------------------
// mcp install
// ---------------------------------------------------------------------------

describe('mcp install', () => {
  it('installs a repo preset for claude into the project scope', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('github', { param: true }) });
    const { program, fs: h, logs } = harness(fs);

    await run(program, [
      'install',
      'github',
      '--project',
      PROJECT_PATH,
      '--agent',
      'claude',
      '--param',
      'api_key=secret123',
    ]);

    expect(logs.some((l) => l.includes('Installed:'))).toBe(true);

    const nativeText = await h.readFile(`${PROJECT_PATH}/.mcp.json`);
    expect(nativeText).toContain('github_1');
    expect(nativeText).toContain('secret123');

    const ledgerText = await h.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`);
    const ledger = parseSkmcp(ledgerText);
    expect(ledger?.servers).toHaveLength(1);
    expect(ledger?.servers[0]?.source).toBe('github');
    expect(ledger?.servers[0]?.remote).toBe('git@github.com:acme/mcps.git');

    const paramsText = await h.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.params.yml`);
    const params = parseSkmcpParams(paramsText);
    expect(params['github_1']).toEqual({ api_key: 'secret123' });

    // Gitignore is ensured on first project-scope install.
    const gitignore = await h.readFile(`${PROJECT_PATH}/.gitignore`);
    expect(gitignore).toContain('.skmcp.params.yml');
  });

  it('supports a comma-separated --agent list, installing into each', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('multi') });
    const { program, fs: h } = harness(fs);

    await run(program, [
      'install',
      'multi',
      '--project',
      PROJECT_PATH,
      '--agent',
      'claude,cursor',
    ]);

    expect(await h.exists(`${PROJECT_PATH}/.mcp.json`)).toBe(true);
    expect(await h.exists(`${PROJECT_PATH}/.cursor/mcp.json`)).toBe(true);
  });

  it('supports repeated --agent flags, installing into each', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('multi') });
    const { program, fs: h } = harness(fs);

    await run(program, [
      'install',
      'multi',
      '--project',
      PROJECT_PATH,
      '--agent',
      'claude',
      '--agent',
      'cursor',
    ]);

    expect(await h.exists(`${PROJECT_PATH}/.mcp.json`)).toBe(true);
    expect(await h.exists(`${PROJECT_PATH}/.cursor/mcp.json`)).toBe(true);
  });

  it('installs a manual preset by its config-assigned identity', async () => {
    const fs = await seed({}, []);
    const manual: McpPreset = {
      id: 'manual-1',
      name: 'manual-server',
      type: 'stdio',
      command: 'npx',
      args: ['manual-server'],
    };
    const { program, fs: h } = harness(fs, [manual]);

    await run(program, ['install', 'manual-server', '--project', PROJECT_PATH, '--agent', 'claude']);

    const ledgerText = await h.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`);
    const ledger = parseSkmcp(ledgerText);
    expect(ledger?.servers[0]?.local).toBe('manual-1');
    expect(ledger?.servers[0]?.remote).toBeUndefined();
  });

  it('exits 1 and installs nothing when a required param value is missing', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('github', { param: true }) });
    const { program, fs: h, errors } = harness(fs);

    await expect(
      run(program, ['install', 'github', '--project', PROJECT_PATH, '--agent', 'claude']),
    ).rejects.toThrow('process.exit(1)');

    expect(errors.some((e) => e.includes('api_key'))).toBe(true);
    expect(await h.exists(`${PROJECT_PATH}/.mcp.json`)).toBe(false);
  });

  it('skips an agent that cannot express the preset transport', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: HTTP_MCP_YML('remote-http') });
    const { program, fs: h, logs } = harness(fs);

    // codex is stdio-only; claude supports http -- one skip, one install.
    await run(program, [
      'install',
      'remote-http',
      '--project',
      PROJECT_PATH,
      '--agent',
      'codex,claude',
    ]);

    expect(logs.some((l) => l.toLowerCase().includes('skipped codex'))).toBe(true);
    expect(await h.exists(`${PROJECT_PATH}/.mcp.json`)).toBe(true);
    expect(await h.exists(`${HOME}/.codex/config.toml`)).toBe(false);
  });

  it('exits 1 when the only requested agent cannot express the transport', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: HTTP_MCP_YML('remote-http') });
    const { program } = harness(fs);

    await expect(
      run(program, ['install', 'remote-http', '--project', PROJECT_PATH, '--agent', 'codex']),
    ).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 for an unknown preset name', async () => {
    const fs = await seed({});
    const { program, errors } = harness(fs);

    await expect(
      run(program, ['install', 'does-not-exist', '--project', PROJECT_PATH, '--agent', 'claude']),
    ).rejects.toThrow('process.exit(1)');
    expect(errors.some((e) => e.includes('not found'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mcp remove
// ---------------------------------------------------------------------------

describe('mcp remove', () => {
  it('removes a previously installed instance', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('github') });
    const { program, fs: h, logs } = harness(fs);

    await run(program, ['install', 'github', '--project', PROJECT_PATH, '--agent', 'claude']);
    await run(program, ['remove', 'github_1', '--project', PROJECT_PATH, '--agent', 'claude']);

    expect(logs.some((l) => l.includes('Removed:'))).toBe(true);
    const nativeText = await h.readFile(`${PROJECT_PATH}/.mcp.json`);
    expect(nativeText).not.toContain('github_1');
    const ledger = parseSkmcp(await h.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`));
    expect(ledger?.servers).toHaveLength(0);
  });

  it('exits 1 when the instance is not found', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('github') });
    const { program } = harness(fs);

    await run(program, ['install', 'github', '--project', PROJECT_PATH, '--agent', 'claude']);
    await expect(
      run(program, ['remove', 'nope', '--project', PROJECT_PATH, '--agent', 'claude']),
    ).rejects.toThrow('process.exit(1)');
  });
});

// ---------------------------------------------------------------------------
// mcp update
// ---------------------------------------------------------------------------

describe('mcp update', () => {
  it('reinstalls under the same instance name when the source definition changed', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('github') });
    const { program, fs: h, logs } = harness(fs);

    await run(program, ['install', 'github', '--project', PROJECT_PATH, '--agent', 'claude']);
    const beforeLedger = parseSkmcp(await h.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`));
    const beforeHash = beforeLedger?.servers[0]?.hash;

    // Change the source def (adds a new required param).
    await h.writeFile(`${REPO_PATH}/mcp.yml`, MCP_YML('github', { param: true }));

    await run(program, [
      'update',
      'github',
      '--project',
      PROJECT_PATH,
      '--agent',
      'claude',
      '--param',
      'api_key=new-secret',
    ]);

    expect(logs.some((l) => l.includes('Updated:'))).toBe(true);
    const afterLedger = parseSkmcp(await h.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`));
    expect(afterLedger?.servers).toHaveLength(1);
    expect(afterLedger?.servers[0]?.name).toBe('github_1');
    expect(afterLedger?.servers[0]?.hash).not.toBe(beforeHash);

    const nativeText = await h.readFile(`${PROJECT_PATH}/.mcp.json`);
    expect(nativeText).toContain('new-secret');
  });

  it('reports nothing to update when the source definition is unchanged', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('github') });
    const { program, logs } = harness(fs);

    await run(program, ['install', 'github', '--project', PROJECT_PATH, '--agent', 'claude']);
    await run(program, ['update', 'github', '--project', PROJECT_PATH, '--agent', 'claude']);

    expect(logs.some((l) => l.includes('No MCP updates available.'))).toBe(true);
  });

  it('aborts (exit 1) when a newly-required param value is missing', async () => {
    const fs = await seed({ [`${REPO_PATH}/mcp.yml`]: MCP_YML('github') });
    const { program, fs: h, errors } = harness(fs);

    await run(program, ['install', 'github', '--project', PROJECT_PATH, '--agent', 'claude']);
    await h.writeFile(`${REPO_PATH}/mcp.yml`, MCP_YML('github', { param: true }));

    await expect(
      run(program, ['update', 'github', '--project', PROJECT_PATH, '--agent', 'claude']),
    ).rejects.toThrow('process.exit(1)');
    expect(errors.some((e) => e.includes('api_key'))).toBe(true);

    // The old instance is left untouched (no partial removal).
    const ledger = parseSkmcp(await h.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`));
    expect(ledger?.servers).toHaveLength(1);
    expect(ledger?.servers[0]?.name).toBe('github_1');
  });
});
