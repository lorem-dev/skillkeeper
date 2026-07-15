/**
 * Real filesystem implementation of {@link FsPort} backed by `node:fs`.
 *
 * This is the production counterpart to the in-memory test fake and the only
 * place in core, besides `git/systemGit.ts`, that performs direct Node I/O. It
 * is a thin adapter over `node:fs/promises` and is excluded from the coverage
 * gate; correctness is covered by the engine tests that run against the
 * in-memory fake plus integration use in the CLI and desktop app.
 */
import { constants } from 'node:fs';
import { chmod, access, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { FileStat, FsPort } from './ports.js';

const OWNER_EXEC = 0o100;
const ALL_EXEC = 0o111;

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

/** Create a filesystem port backed by the real `node:fs` module. */
export const createNodeFs = (): FsPort => ({
  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  },

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  },

  async list(path: string): Promise<string[]> {
    return readdir(path);
  },

  async stat(path: string): Promise<FileStat | undefined> {
    try {
      const info = await stat(path);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        executable: (info.mode & OWNER_EXEC) !== 0,
        size: info.size,
      };
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  },

  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  },

  async removeDirIfEmpty(path: string): Promise<void> {
    try {
      await rmdir(path);
    } catch (error) {
      if (isErrnoException(error) && (error.code === 'ENOTEMPTY' || error.code === 'ENOENT')) {
        return;
      }
      throw error;
    }
  },

  async chmod(path: string, executable: boolean): Promise<void> {
    const info = await stat(path);
    const next = executable ? info.mode | ALL_EXEC : info.mode & ~ALL_EXEC;
    await chmod(path, next);
  },

  async rename(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  },
});
