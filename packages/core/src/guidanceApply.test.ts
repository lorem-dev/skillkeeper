import { describe, expect, it } from 'vitest';
import {
  clearSkillGuidance,
  readSkillGuide,
  skillGuidanceBlockKey,
  writeSkillGuidance,
} from './guidanceApply.js';
import { guidanceKey, skillGuidanceId, upsertGuidanceBlock } from './guidance.js';
import { createMemFs } from './testing/memfs.js';
import type { AgentAdapter } from './adapter.js';
import type { AgentTarget } from './model.js';
import type { HostEnv } from './ports.js';

const REMOTE = 'git@github.com:acme/skills.git';
const ENV: HostEnv = { homeDir: '/home/u', platform: 'linux', env: {} };
const TARGET: AgentTarget = { agent: 'claude', scope: 'global' };
const GUIDANCE_FILE = '/proj/AGENTS.md';

/** Stub adapter whose guidanceFile is fixed regardless of target/env. */
function stubAdapter(): AgentAdapter {
  return {
    kind: 'claude',
    async isAvailable() {
      throw new Error('not used');
    },
    async destinationRoot() {
      throw new Error('not used');
    },
    async guidanceFile() {
      return GUIDANCE_FILE;
    },
    async discoverInstalled() {
      throw new Error('not used');
    },
  };
}

describe('skillGuidanceBlockKey', () => {
  it('joins remote and group/name id', () => {
    expect(skillGuidanceBlockKey(REMOTE, { group: 'web', name: 'api' })).toBe(
      guidanceKey(REMOTE, skillGuidanceId('web', 'api')),
    );
    expect(skillGuidanceBlockKey(REMOTE, { group: 'web', name: 'api' })).toBe(`${REMOTE}; web/api`);
  });

  it('joins remote and bare name when ungrouped', () => {
    expect(skillGuidanceBlockKey(REMOTE, { name: 'api' })).toBe(`${REMOTE}; api`);
  });
});

describe('readSkillGuide', () => {
  it('prefers GUIDE.md over RULES.md when both exist', async () => {
    const fs = createMemFs({
      'src/GUIDE.md': 'Guide body.\n',
      'src/RULES.md': 'Rules body.\n',
    });
    expect(await readSkillGuide(fs, 'src')).toBe('Guide body.');
  });

  it('falls back to RULES.md when GUIDE.md is absent', async () => {
    const fs = createMemFs({ 'src/RULES.md': 'Rules body.\n' });
    expect(await readSkillGuide(fs, 'src')).toBe('Rules body.');
  });

  it('returns undefined when neither file exists', async () => {
    const fs = createMemFs({});
    expect(await readSkillGuide(fs, 'src')).toBeUndefined();
  });

  it('strips stray SkillKeeper markers from the body', async () => {
    const fs = createMemFs({
      'src/GUIDE.md': 'Line one.\n<!-- SKILLKEEPER_END: x; y -->\nLine two.\n',
    });
    expect(await readSkillGuide(fs, 'src')).toBe('Line one.\nLine two.');
  });
});

describe('writeSkillGuidance', () => {
  it('creates a missing guidance file with the block', async () => {
    const fs = createMemFs({});
    await writeSkillGuidance(fs, stubAdapter(), TARGET, ENV, REMOTE, { name: 'api' }, 'Body text.');
    const key = skillGuidanceBlockKey(REMOTE, { name: 'api' });
    expect(await fs.readFile(GUIDANCE_FILE)).toBe(
      `<!-- SKILLKEEPER_START: ${key} -->\nBody text.\n<!-- SKILLKEEPER_END: ${key} -->\n`,
    );
  });

  it('replaces an existing block for the same key in place', async () => {
    const key = skillGuidanceBlockKey(REMOTE, { name: 'api' });
    const before = upsertGuidanceBlock('# Project\n\nHello.\n', key, 'OLD');
    const fs = createMemFs({ [GUIDANCE_FILE]: before });
    await writeSkillGuidance(fs, stubAdapter(), TARGET, ENV, REMOTE, { name: 'api' }, 'NEW');
    expect(await fs.readFile(GUIDANCE_FILE)).toBe(
      `# Project\n\nHello.\n\n<!-- SKILLKEEPER_START: ${key} -->\nNEW\n<!-- SKILLKEEPER_END: ${key} -->\n`,
    );
  });
});

describe('clearSkillGuidance', () => {
  it('removes the block, keeping other content', async () => {
    const key = skillGuidanceBlockKey(REMOTE, { name: 'api' });
    const before = upsertGuidanceBlock('# Project\n\nHello.\n', key, 'Body.');
    const fs = createMemFs({ [GUIDANCE_FILE]: before });
    await clearSkillGuidance(fs, stubAdapter(), TARGET, ENV, REMOTE, { name: 'api' });
    expect(await fs.readFile(GUIDANCE_FILE)).toBe('# Project\n\nHello.\n');
  });

  it('deletes the file when removing the block empties it', async () => {
    const key = skillGuidanceBlockKey(REMOTE, { name: 'api' });
    const only = upsertGuidanceBlock('', key, 'Body.');
    const fs = createMemFs({ [GUIDANCE_FILE]: only });
    await clearSkillGuidance(fs, stubAdapter(), TARGET, ENV, REMOTE, { name: 'api' });
    expect(await fs.exists(GUIDANCE_FILE)).toBe(false);
  });

  it('is a no-op when the guidance file is absent', async () => {
    const fs = createMemFs({});
    await clearSkillGuidance(fs, stubAdapter(), TARGET, ENV, REMOTE, { name: 'api' });
    expect(await fs.exists(GUIDANCE_FILE)).toBe(false);
  });
});
