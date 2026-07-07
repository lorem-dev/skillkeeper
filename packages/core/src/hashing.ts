import { createHash } from 'node:crypto';
import type { FsPort } from './ports.js';
import type { InstallManifest, ManagedFile, ResolvedSkill } from './model.js';

/** Name of the SkillKeeper identity file, excluded from content hashing. */
export const SKID_FILE = '.skid.yml';

/** Basename of a skill-relative path. */
function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

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

/**
 * Content hash of a skill body: a single SHA-256 over the sorted, skill-relative
 * `relPath\0sha256` lines, ignoring the executable bit and excluding the
 * `.skid.yml` identity file. `relPath` MUST already be relative to the skill
 * directory (not the repo root, not the install dest); callers normalize the
 * prefix first so identical content yields an identical hash everywhere.
 */
export function contentHash(entries: readonly { relPath: string; sha256: string }[]): string {
  const lines = entries
    .filter((e) => baseName(e.relPath) !== SKID_FILE)
    .map((e) => `${e.relPath}\0${e.sha256}`)
    .sort();
  return sha256(lines.join('\n'));
}

/**
 * Content hash of a resolved (working-tree) skill's body. Reads each body file
 * and hashes by skill-relative path (`rootPath` prefix stripped).
 */
export async function resolvedContentHash(
  fs: FsPort,
  sourceRoot: string,
  resolved: ResolvedSkill,
): Promise<string> {
  const entries: { relPath: string; sha256: string }[] = [];
  for (const rel of resolved.files) {
    const within = rel.slice(resolved.rootPath.length + 1);
    entries.push({ relPath: within, sha256: sha256(await fs.readFile(`${sourceRoot}/${rel}`)) });
  }
  return contentHash(entries);
}

/**
 * Content hash of an installed skill from its manifest. Strips the leading
 * `<skill name>/` install-dir prefix from each managed file's `relPath`.
 */
export function manifestContentHash(manifest: InstallManifest): string {
  const prefix = `${manifest.skillId.name}/`;
  const entries = manifest.files.map((f) => ({
    relPath: f.relPath.startsWith(prefix) ? f.relPath.slice(prefix.length) : f.relPath,
    sha256: f.sha256,
  }));
  return contentHash(entries);
}
