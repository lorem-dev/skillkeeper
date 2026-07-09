import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMemFs, createFakeGit } from '@skillkeeper/core/testing';
import {
  saveState,
  hashMcpDef,
  serializeSkmcp,
  serializeSkmcpParams,
  parseSkmcp,
  parseSkmcpParams,
} from '@skillkeeper/core';
import type { FsPort, McpServerDef, Project, Repository } from '@skillkeeper/core';
import { listAvailableMcp, applyMcp, listMcpInstalls, resolveMcpTarget } from './mcp.js';
import type { McpDeps } from './mcp.js';
import { createAdapterRegistry } from './skills.js';
import type { RepoDeps } from './repositories.js';

const STATE_PATH = '/state.json';
const REPO_PATH = '/repos/r1';
const HOME = '/home/alice';
const PROJECT_PATH = '/work/proj';
const PROJECT_ID = 'p1';

function mcpDeps(fs: FsPort): McpDeps {
  return {
    fs,
    statePath: STATE_PATH,
    registry: createAdapterRegistry(),
    adapterEnv: { homeDir: HOME, platform: 'linux', env: {}, fs },
  };
}

const SKILL = (name: string): string => `---\nname: ${name}\n---\n# ${name}\n`;

const MCP_YML = (serverName: string): string =>
  `version: 1\nservers:\n  - name: ${serverName}\n    type: stdio\n    command: npx\n    args:\n      - ${serverName}\n`;

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

async function makeDeps(seed: Record<string, string>, repos: Repository[] = [repo()]): Promise<RepoDeps> {
  const fs = createMemFs(seed);
  await saveState(fs, STATE_PATH, { version: 1, repositories: repos, projects: [], installs: [] });
  return {
    fs,
    git: createFakeGit(),
    statePath: STATE_PATH,
    reposDir: '/repos',
  };
}

describe('listAvailableMcp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns servers from a root mcp.yml and a skill-group mcp.yml with correct group and hash', async () => {
    const deps = await makeDeps({
      [`${REPO_PATH}/mcp.yml`]: MCP_YML('root-server'),
      [`${REPO_PATH}/web/mySkill/SKILL.md`]: SKILL('mySkill'),
      [`${REPO_PATH}/web/mcp.yml`]: MCP_YML('web-server'),
    });

    const out = await listAvailableMcp(deps);

    expect(out).toHaveLength(2);
    const root = out.find((m) => m.def.name === 'root-server');
    const grouped = out.find((m) => m.def.name === 'web-server');
    expect(root).toBeDefined();
    expect(root?.group).toBeUndefined();
    expect(root?.repoId).toBe('r1');
    expect(root?.remote).toBe('git@github.com:acme/mcps.git');
    expect(root?.hash).toBe(hashMcpDef(root!.def));

    expect(grouped).toBeDefined();
    expect(grouped?.group).toBe('web');
    expect(grouped?.hash).toBe(hashMcpDef(grouped!.def));
  });

  it('prefers mcp.yml over mcp.yaml when both are present', async () => {
    const deps = await makeDeps({
      [`${REPO_PATH}/mcp.yml`]: MCP_YML('yml-server'),
      [`${REPO_PATH}/mcp.yaml`]: MCP_YML('yaml-server'),
    });

    const out = await listAvailableMcp(deps);

    expect(out).toHaveLength(1);
    expect(out[0]?.def.name).toBe('yml-server');
  });

  it('falls back to mcp.yaml when mcp.yml is absent', async () => {
    const deps = await makeDeps({
      [`${REPO_PATH}/mcp.yaml`]: MCP_YML('yaml-only'),
    });

    const out = await listAvailableMcp(deps);

    expect(out).toHaveLength(1);
    expect(out[0]?.def.name).toBe('yaml-only');
  });

  it('skips a malformed mcp.yml with a warning instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = await makeDeps({
      [`${REPO_PATH}/mcp.yml`]: 'version: 1\nservers:\n  - name: bad\n    type: stdio\n', // stdio needs command
      [`${REPO_PATH}/web/mySkill/SKILL.md`]: SKILL('mySkill'),
      [`${REPO_PATH}/web/mcp.yml`]: MCP_YML('web-server'),
    });

    const list = await listAvailableMcp(deps);

    expect(list).toHaveLength(1);
    expect(list[0]?.def.name).toBe('web-server');
    expect(warn).toHaveBeenCalled();
  });

  it('skips a repo whose clone is missing, and continues with other repos', async () => {
    const deps = await makeDeps(
      {
        [`${REPO_PATH}/mcp.yml`]: MCP_YML('present-server'),
      },
      [repo({ id: 'r1', localPath: REPO_PATH }), repo({ id: 'r2', localPath: '/repos/missing', url: 'x' })],
    );

    const out = await listAvailableMcp(deps);

    expect(out).toHaveLength(1);
    expect(out[0]?.repoId).toBe('r1');
  });

  it('finds the mcp.yml in the actual group directory even when skillkeeper.repo.yaml assigns a custom group label', async () => {
    const deps = await makeDeps({
      [`${REPO_PATH}/skillkeeper.repo.yaml`]:
        'version: 1\nskills:\n  - path: features/onboarding\n    group: getting-started\n',
      [`${REPO_PATH}/features/onboarding/SKILL.md`]: SKILL('onboarding'),
      [`${REPO_PATH}/features/mcp.yml`]: MCP_YML('features-server'),
    });

    const out = await listAvailableMcp(deps);

    expect(out).toHaveLength(1);
    expect(out[0]?.group).toBe('features');
    expect(out[0]?.def.name).toBe('features-server');
  });

  it('returns an empty list when there is no state file', async () => {
    const fs = createMemFs();
    const deps: RepoDeps = { fs, git: createFakeGit(), statePath: STATE_PATH, reposDir: '/repos' };
    expect(await listAvailableMcp(deps)).toEqual([]);
  });
});

const STDIO_DEF: McpServerDef = {
  name: 'github',
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'gh-mcp'],
};

const HTTP_DEF: McpServerDef = {
  name: 'remote-http',
  type: 'http',
  url: 'https://example.test/mcp',
};

describe('resolveMcpTarget', () => {
  it('resolves a project agent under the project skills root', async () => {
    const deps = mcpDeps(createMemFs());
    const target = await resolveMcpTarget(deps, 'claude', {
      projectPath: PROJECT_PATH,
      projectId: PROJECT_ID,
    });
    expect(target.nativePath).toBe(`${PROJECT_PATH}/.mcp.json`);
    expect(target.ledgerPath).toBe(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`);
    expect(target.paramsPath).toBe(`${PROJECT_PATH}/.claude/skills/.skmcp.params.yml`);
    expect(target.guidanceFiles).toEqual([`${PROJECT_PATH}/.claude/CLAUDE.md`]);
  });

  it('resolves codex globally, ignoring the project path', async () => {
    const deps = mcpDeps(createMemFs());
    const target = await resolveMcpTarget(deps, 'codex', {
      projectPath: PROJECT_PATH,
      projectId: PROJECT_ID,
    });
    expect(target.nativePath).toBe(`${HOME}/.codex/config.toml`);
    expect(target.ledgerPath).toBe(`${HOME}/.codex/skills/.skmcp.yml`);
    expect(target.paramsPath).toBe(`${HOME}/.codex/skills/.skmcp.params.yml`);
    expect(target.guidanceFiles).toEqual([`${HOME}/AGENTS.md`]);
  });
});

describe('applyMcp', () => {
  it('installs a project agent: writes native config, ledger, and params', async () => {
    const fs = createMemFs();
    const result = await applyMcp(mcpDeps(fs), {
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      batches: [
        {
          agent: 'claude',
          install: [
            {
              identity: { remote: 'git@github.com:acme/mcps.git', source: 'github' },
              def: STDIO_DEF,
              values: {},
            },
          ],
          remove: [],
        },
      ],
    });

    expect(result).toEqual({ ok: true, installed: 1, removed: 0, skipped: [] });

    const nativeText = await fs.readFile(`${PROJECT_PATH}/.mcp.json`);
    expect(nativeText).toContain('github_1');
    expect(nativeText).toContain('mcpServers');

    const ledger = parseSkmcp(await fs.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`));
    expect(ledger?.servers).toHaveLength(1);
    expect(ledger?.servers[0]).toMatchObject({
      remote: 'git@github.com:acme/mcps.git',
      source: 'github',
      name: 'github_1',
      hash: hashMcpDef(STDIO_DEF),
    });

    const params = parseSkmcpParams(
      await fs.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.params.yml`),
    );
    expect(params['github_1']).toEqual({});
    // Project-scope install seeds the .gitignore param exclusion.
    expect(await fs.exists(`${PROJECT_PATH}/.gitignore`)).toBe(true);
  });

  it('skips a codex http install as an unsupported transport', async () => {
    const fs = createMemFs();
    const result = await applyMcp(mcpDeps(fs), {
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      batches: [
        {
          agent: 'codex',
          install: [
            {
              identity: { remote: 'git@github.com:acme/mcps.git', source: 'remote_http' },
              def: HTTP_DEF,
              values: {},
            },
          ],
          remove: [],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installed).toBe(0);
      expect(result.skipped).toEqual([{ agent: 'codex', source: 'remote_http', transport: 'http' }]);
    }
    // Nothing was written to the codex native config or ledger.
    expect(await fs.exists(`${HOME}/.codex/config.toml`)).toBe(false);
    expect(await fs.exists(`${HOME}/.codex/skills/.skmcp.yml`)).toBe(false);
  });

  it('removes an installed instance', async () => {
    const fs = createMemFs();
    const deps = mcpDeps(fs);
    await applyMcp(deps, {
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      batches: [
        {
          agent: 'claude',
          install: [{ identity: { remote: 'r', source: 'github' }, def: STDIO_DEF, values: {} }],
          remove: [],
        },
      ],
    });
    const result = await applyMcp(deps, {
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      batches: [{ agent: 'claude', install: [], remove: [{ instanceName: 'github_1' }] }],
    });
    expect(result).toMatchObject({ ok: true, removed: 1 });
    const ledger = parseSkmcp(await fs.readFile(`${PROJECT_PATH}/.claude/skills/.skmcp.yml`));
    expect(ledger?.servers).toHaveLength(0);
  });
});

describe('listMcpInstalls', () => {
  async function seededDeps(): Promise<McpDeps> {
    const fs = createMemFs();
    const project: Project = {
      id: PROJECT_ID,
      name: 'proj',
      path: PROJECT_PATH,
      addedAt: new Date().toISOString(),
    };
    await saveState(fs, STATE_PATH, {
      version: 1,
      repositories: [],
      projects: [project],
      installs: [],
    });
    // A claude project ledger with a repo entry and a manual (local) entry.
    await fs.writeFile(
      `${PROJECT_PATH}/.claude/skills/.skmcp.yml`,
      serializeSkmcp({
        schema: 1,
        servers: [
          { remote: 'git@github.com:acme/mcps.git', group: 'web', source: 'github', name: 'github_1', hash: 'sha256:aaa' },
          { local: 'preset-1', source: 'mymanual', name: 'mymanual_1', hash: 'sha256:bbb' },
        ],
      }),
    );
    await fs.writeFile(
      `${PROJECT_PATH}/.claude/skills/.skmcp.params.yml`,
      serializeSkmcpParams({ github_1: { token: 'x' } }),
    );
    // A codex global ledger.
    await fs.writeFile(
      `${HOME}/.codex/skills/.skmcp.yml`,
      serializeSkmcp({
        schema: 1,
        servers: [{ remote: 'git@github.com:acme/mcps.git', source: 'localstdio', name: 'localstdio_1', hash: 'sha256:ccc' }],
      }),
    );
    return mcpDeps(fs);
  }

  it('maps project and global ledger entries with identity, hash, and hasParams', async () => {
    const out = await listMcpInstalls(await seededDeps());

    const repoEntry = out.find((m) => m.instanceName === 'github_1');
    expect(repoEntry).toMatchObject({
      projectId: PROJECT_ID,
      agent: 'claude',
      identity: { remote: 'git@github.com:acme/mcps.git', group: 'web', source: 'github' },
      hash: 'sha256:aaa',
      hasParams: true,
    });

    const manualEntry = out.find((m) => m.instanceName === 'mymanual_1');
    expect(manualEntry).toMatchObject({
      projectId: PROJECT_ID,
      agent: 'claude',
      identity: { local: 'preset-1', source: 'mymanual' },
      hasParams: false,
    });

    const codexEntry = out.find((m) => m.instanceName === 'localstdio_1');
    expect(codexEntry).toMatchObject({
      projectId: 'global',
      agent: 'codex',
      identity: { remote: 'git@github.com:acme/mcps.git', source: 'localstdio' },
      hash: 'sha256:ccc',
      hasParams: false,
    });
  });
});
