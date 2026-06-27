import type { FileStat, FsPort } from '../ports.js';

interface MemFile {
  content: string;
  executable: boolean;
}

/** Normalize a path: collapse repeated slashes, drop trailing slash, trim. */
function normalize(path: string): string {
  const collapsed = path.replace(/\/+/g, '/').replace(/\/$/, '');
  return collapsed.startsWith('./') ? collapsed.slice(2) : collapsed;
}

function parent(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '' : path.slice(0, idx);
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

/**
 * Create an in-memory {@link FsPort} for tests. Directories are modeled
 * implicitly by file path prefixes, plus an explicit set for empty directories
 * created via {@link FsPort.mkdir}. The executable bit is tracked per file so
 * chmod behavior can be asserted.
 *
 * @param seed Optional map of relative path -> file contents.
 */
export function createMemFs(seed: Record<string, string> = {}): FsPort {
  const files = new Map<string, MemFile>();
  const dirs = new Set<string>();

  function registerDirs(path: string): void {
    let p = parent(path);
    while (p !== '') {
      dirs.add(p);
      p = parent(p);
    }
  }

  for (const [rawPath, content] of Object.entries(seed)) {
    const path = normalize(rawPath);
    files.set(path, { content, executable: false });
    registerDirs(path);
  }

  function isDir(path: string): boolean {
    if (dirs.has(path)) return true;
    const prefix = `${path}/`;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  return {
    async readFile(rawPath: string): Promise<string> {
      const path = normalize(rawPath);
      const file = files.get(path);
      if (file === undefined) {
        if (isDir(path)) fail('EISDIR', path);
        fail('ENOENT', path);
      }
      return file.content;
    },

    async writeFile(rawPath: string, content: string): Promise<void> {
      const path = normalize(rawPath);
      const existing = files.get(path);
      files.set(path, { content, executable: existing?.executable ?? false });
      registerDirs(path);
    },

    async list(rawPath: string): Promise<string[]> {
      const path = normalize(rawPath);
      if (files.has(path)) fail('ENOTDIR', path);
      if (!isDir(path)) fail('ENOENT', path);
      const prefix = path === '' ? '' : `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && key !== path) {
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');
          names.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        if (dir.startsWith(prefix) && dir !== path) {
          const rest = dir.slice(prefix.length);
          const slash = rest.indexOf('/');
          names.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }
      return [...names];
    },

    async stat(rawPath: string): Promise<FileStat | undefined> {
      const path = normalize(rawPath);
      const file = files.get(path);
      if (file !== undefined) {
        return {
          isFile: true,
          isDirectory: false,
          executable: file.executable,
          size: Buffer.byteLength(file.content, 'utf8'),
        };
      }
      if (isDir(path)) {
        return { isFile: false, isDirectory: true, executable: false, size: 0 };
      }
      return undefined;
    },

    async exists(rawPath: string): Promise<boolean> {
      const path = normalize(rawPath);
      return files.has(path) || isDir(path);
    },

    async mkdir(rawPath: string): Promise<void> {
      const path = normalize(rawPath);
      if (path === '') return;
      dirs.add(path);
      registerDirs(path);
    },

    async remove(rawPath: string): Promise<void> {
      const path = normalize(rawPath);
      files.delete(path);
    },

    async removeDirIfEmpty(rawPath: string): Promise<void> {
      const path = normalize(rawPath);
      if (!isDir(path)) return;
      const prefix = `${path}/`;
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) return;
      }
      for (const dir of dirs) {
        if (dir.startsWith(prefix)) return;
      }
      dirs.delete(path);
    },

    async chmod(rawPath: string, executable: boolean): Promise<void> {
      const path = normalize(rawPath);
      const file = files.get(path);
      if (file === undefined) fail('ENOENT', path);
      file.executable = executable;
    },

    async rename(rawFrom: string, rawTo: string): Promise<void> {
      const from = normalize(rawFrom);
      const to = normalize(rawTo);
      const file = files.get(from);
      if (file !== undefined) {
        files.delete(from);
        files.set(to, file);
        registerDirs(to);
        return;
      }
      if (isDir(from)) {
        const prefix = `${from}/`;
        for (const [key, value] of [...files.entries()]) {
          if (key.startsWith(prefix)) {
            files.delete(key);
            files.set(`${to}/${key.slice(prefix.length)}`, value);
          }
        }
        dirs.delete(from);
        dirs.add(to);
        return;
      }
      fail('ENOENT', from);
    },
  };
}
