import { describe, expect, it } from 'vitest';
import { ensureGitignore } from './gitignoreEnsure.js';
import { createMemFs } from './testing/memfs.js';
import type { FsPort } from './ports.js';

const PROJECT = '/proj';
const GITIGNORE = `${PROJECT}/.gitignore`;
const COMMENT = '# SkillKeeper MCP parameter values';
const LINE_YML = '.skmcp.params.yml';
const LINE_YAML = '.skmcp.params.yaml';

/** Wrap an FsPort, counting writeFile calls without changing its behavior. */
function withWriteSpy(fs: FsPort): { fs: FsPort; writeCount: () => number } {
  let count = 0;
  const spy: FsPort = {
    ...fs,
    async writeFile(path: string, content: string): Promise<void> {
      count += 1;
      await fs.writeFile(path, content);
    },
  };
  return { fs: spy, writeCount: () => count };
}

describe('ensureGitignore', () => {
  it('creates .gitignore with the comment and both lines when absent', async () => {
    const fs = createMemFs({});
    await ensureGitignore(fs, PROJECT);
    expect(await fs.readFile(GITIGNORE)).toBe(`${COMMENT}\n${LINE_YML}\n${LINE_YAML}\n`);
  });

  it('appends the missing lines under a new comment, preserving existing content', async () => {
    const fs = createMemFs({ [GITIGNORE]: 'node_modules\ndist\n' });
    await ensureGitignore(fs, PROJECT);
    expect(await fs.readFile(GITIGNORE)).toBe(
      `node_modules\ndist\n${COMMENT}\n${LINE_YML}\n${LINE_YAML}\n`,
    );
  });

  it('appends only the missing line when the comment is already present', async () => {
    const fs = createMemFs({ [GITIGNORE]: `node_modules\n${COMMENT}\n${LINE_YML}\n` });
    await ensureGitignore(fs, PROJECT);
    expect(await fs.readFile(GITIGNORE)).toBe(`node_modules\n${COMMENT}\n${LINE_YML}\n${LINE_YAML}\n`);
  });

  it('handles a file missing a trailing newline', async () => {
    const fs = createMemFs({ [GITIGNORE]: 'node_modules' });
    await ensureGitignore(fs, PROJECT);
    expect(await fs.readFile(GITIGNORE)).toBe(`node_modules\n${COMMENT}\n${LINE_YML}\n${LINE_YAML}\n`);
  });

  it('does not write at all when both lines are already present', async () => {
    const fs = createMemFs({ [GITIGNORE]: `${COMMENT}\n${LINE_YML}\n${LINE_YAML}\n` });
    const { fs: spy, writeCount } = withWriteSpy(fs);
    await ensureGitignore(spy, PROJECT);
    expect(writeCount()).toBe(0);
    expect(await fs.readFile(GITIGNORE)).toBe(`${COMMENT}\n${LINE_YML}\n${LINE_YAML}\n`);
  });

  it('is idempotent across repeated calls', async () => {
    const fs = createMemFs({});
    await ensureGitignore(fs, PROJECT);
    await ensureGitignore(fs, PROJECT);
    expect(await fs.readFile(GITIGNORE)).toBe(`${COMMENT}\n${LINE_YML}\n${LINE_YAML}\n`);
  });
});
