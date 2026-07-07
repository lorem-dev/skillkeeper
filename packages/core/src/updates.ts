import { manifestContentHash, resolvedContentHash } from './hashing.js';
import type { GitPort } from './ports.js';
import type { FsPort } from './ports.js';
import type { InstallManifest, Repository, ResolvedSkill } from './model.js';

/** Revision used to resolve the tracked upstream ref. */
const UPSTREAM = '@{upstream}';

/**
 * Repository-level update detection. Fetches, then compares the local `HEAD`
 * to the tracked upstream ref. The repository "can be updated" when they differ.
 * Read-only: a fetch does not modify the working tree or any install.
 *
 * @param git Git port for the local, instant comparisons (rev-parse).
 * @param repo Repository whose `localPath` is checked.
 * @param fetchGit Git port used for the network fetch; defaults to `git`. Pass a
 *   terminal-backed port so the fetch runs in the interactive shell (visible,
 *   ssh-capable) like a pull, while the rev-parse comparisons stay silent.
 */
export async function repoHasUpdate(
  git: GitPort,
  repo: Repository,
  fetchGit: GitPort = git,
): Promise<boolean> {
  await fetchGit.fetch(repo.localPath);
  const local = await git.revParse(repo.localPath, 'HEAD');
  const upstream = await git.revParse(repo.localPath, UPSTREAM);
  return local.oid !== upstream.oid;
}

/**
 * Skill-level update detection. Compares the content hashes of the resolved
 * skill's body files in the working tree against the hashes recorded in the
 * install manifest. The skill "can be updated" when the source content differs
 * from what is installed (a changed, added, or removed file).
 *
 * @param fs Filesystem port.
 * @param sourceRoot Working-tree root the resolved paths are relative to.
 * @param resolved The freshly resolved skill from the working tree.
 * @param manifest The recorded install manifest.
 */
export async function skillHasUpdate(
  fs: FsPort,
  sourceRoot: string,
  resolved: ResolvedSkill,
  manifest: InstallManifest,
): Promise<boolean> {
  const source = await resolvedContentHash(fs, sourceRoot, resolved);
  const installed = manifest.contentHash ?? manifestContentHash(manifest);
  return source !== installed;
}
