import { createHash } from 'node:crypto';
import type { FsPort } from './ports.js';
import type { ManagedFile } from './model.js';

/**
 * Compute the lowercase hex SHA-256 digest of the given content.
 *
 * @param content UTF-8 text or raw bytes.
 */
export function sha256(content: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  return hash.digest('hex');
}

/**
 * Hash a set of files under a root directory into {@link ManagedFile} records,
 * sorted by `relPath` for stable, deterministic output.
 *
 * @param fs Filesystem port.
 * @param root Absolute (or caller-resolved) directory the paths are relative to.
 * @param relPaths Paths relative to `root` to hash.
 */
export async function hashTree(
  fs: FsPort,
  root: string,
  relPaths: readonly string[],
): Promise<ManagedFile[]> {
  const sorted = [...relPaths].sort();
  const out: ManagedFile[] = [];
  for (const relPath of sorted) {
    const full = `${root}/${relPath}`;
    const content = await fs.readFile(full);
    const stat = await fs.stat(full);
    out.push({
      relPath,
      sha256: sha256(content),
      executable: stat?.executable ?? false,
    });
  }
  return out;
}
