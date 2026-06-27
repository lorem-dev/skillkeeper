import { describe, it, expect } from 'vitest';
import { createMemFs } from '@skillkeeper/core/testing';
import type { AgentTarget, FsPort } from '@skillkeeper/core';
import { claudeAdapter } from './claude.js';
import { PROJECT_DIR_ENV, type AdapterHostEnv } from './paths.js';

const HOME = '/home/alice';
const PROJECT = '/work/my-project';

function hostEnv(fs: FsPort, projectDir: string | null = PROJECT): AdapterHostEnv {
  return {
    homeDir: HOME,
    platform: 'linux',
    env: projectDir === null ? {} : { [PROJECT_DIR_ENV]: projectDir },
    fs,
  };
}

const projectTarget: AgentTarget = { agent: 'claude', scope: 'project', projectId: 'p1' };
const globalTarget: AgentTarget = { agent: 'claude', scope: 'global' };

describe('claudeAdapter', () => {
  it('identifies as the claude agent', () => {
    expect(claudeAdapter.kind).toBe('claude');
  });

  describe('destinationRoot', () => {
    it('returns <project>/.claude/skills for project scope', async () => {
      const root = await claudeAdapter.destinationRoot(projectTarget, hostEnv(createMemFs()));
      expect(root).toBe(`${PROJECT}/.claude/skills`);
    });

    it('returns ~/.claude/skills for global scope', async () => {
      const root = await claudeAdapter.destinationRoot(globalTarget, hostEnv(createMemFs()));
      expect(root).toBe(`${HOME}/.claude/skills`);
    });

    it('rejects project scope when no project directory is provided', async () => {
      await expect(
        claudeAdapter.destinationRoot(projectTarget, hostEnv(createMemFs(), null)),
      ).rejects.toThrow(/project directory/i);
    });
  });

  describe('hookSupport', () => {
    it('uses the json-merge strategy', () => {
      expect(claudeAdapter.hookSupport?.strategy).toBe('json-merge');
    });

    it('resolves the project settings.json path', async () => {
      const support = claudeAdapter.hookSupport;
      expect(support).toBeDefined();
      const file = await support!.resolveTargetFile(projectTarget, hostEnv(createMemFs()));
      expect(file).toBe(`${PROJECT}/.claude/settings.json`);
    });

    it('resolves the global settings.json path', async () => {
      const support = claudeAdapter.hookSupport;
      const file = await support!.resolveTargetFile(globalTarget, hostEnv(createMemFs()));
      expect(file).toBe(`${HOME}/.claude/settings.json`);
    });
  });

  describe('isAvailable', () => {
    it('is true when the user .claude directory exists', async () => {
      const fs = createMemFs({ [`${HOME}/.claude/settings.json`]: '{}' });
      expect(await claudeAdapter.isAvailable(hostEnv(fs))).toBe(true);
    });

    it('is false when the user .claude directory is absent', async () => {
      expect(await claudeAdapter.isAvailable(hostEnv(createMemFs()))).toBe(false);
    });
  });

  describe('discoverInstalled', () => {
    it('finds skill directories that directly contain SKILL.md', async () => {
      const fs = createMemFs({
        [`${PROJECT}/.claude/skills/external-skill/SKILL.md`]: '# external',
        [`${PROJECT}/.claude/skills/external-skill/run.sh`]: 'echo hi',
        [`${PROJECT}/.claude/skills/another/SKILL.md`]: '# another',
      });
      const found = await claudeAdapter.discoverInstalled(projectTarget, hostEnv(fs));
      const names = found.map((s) => s.name).sort();
      expect(names).toEqual(['another', 'external-skill']);
      const ext = found.find((s) => s.name === 'external-skill');
      expect(ext?.path).toBe(`${PROJECT}/.claude/skills/external-skill`);
      expect(ext?.group).toBeUndefined();
    });

    it('ignores directory entries without a SKILL.md', async () => {
      const fs = createMemFs({
        [`${PROJECT}/.claude/skills/real/SKILL.md`]: '# real',
        [`${PROJECT}/.claude/skills/not-a-skill/notes.txt`]: 'hello',
      });
      const found = await claudeAdapter.discoverInstalled(projectTarget, hostEnv(fs));
      expect(found.map((s) => s.name)).toEqual(['real']);
    });

    it('returns an empty list when the skills directory is missing', async () => {
      const found = await claudeAdapter.discoverInstalled(globalTarget, hostEnv(createMemFs()));
      expect(found).toEqual([]);
    });
  });
});
