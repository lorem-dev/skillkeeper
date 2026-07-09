import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMemFs, createFakeGit } from '@skillkeeper/core/testing';
import { saveState, hashMcpDef } from '@skillkeeper/core';
import type { Repository } from '@skillkeeper/core';
import { listAvailableMcp } from './mcp.js';
import type { RepoDeps } from './repositories.js';

const STATE_PATH = '/state.json';
const REPO_PATH = '/repos/r1';

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

  it('returns an empty list when there is no state file', async () => {
    const fs = createMemFs();
    const deps: RepoDeps = { fs, git: createFakeGit(), statePath: STATE_PATH, reposDir: '/repos' };
    expect(await listAvailableMcp(deps)).toEqual([]);
  });
});
