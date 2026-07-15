import { matchesAny } from '../kernel/glob.js';
import { parseHookManifest, parseSkillManifest } from './manifest.js';
import { parseRepoConfig, RepoConfigError } from './repoConfig.js';
import type { FsPort } from '../kernel/ports.js';
import type { ResolvedHook, ResolvedSkill, SkillId } from '../kernel/model.js';

const SKILL_FILE = 'SKILL.md';
const HOOK_FILE = 'HOOK.md';
const HOOKS_DIR = 'hooks';
const REPO_CONFIG = 'skillkeeper.repo.yaml';

/** Result of resolving skills from a working tree. */
export interface ResolveResult {
  readonly skills: ResolvedSkill[];
  /** Human-readable warnings for unresolved or invalid paths. */
  readonly warnings: string[];
}

/**
 * Recursively list every file path under `dir` (relative to `repoRoot`),
 * returning paths relative to `repoRoot`. Directories themselves are not
 * returned.
 */
async function listFilesRec(fs: FsPort, repoRoot: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  const abs = rel === '' ? repoRoot : `${repoRoot}/${rel}`;
  const entries = await fs.list(abs);
  for (const entry of entries) {
    const childRel = rel === '' ? entry : `${rel}/${entry}`;
    const stat = await fs.stat(`${repoRoot}/${childRel}`);
    if (stat?.isDirectory) {
      out.push(...(await listFilesRec(fs, repoRoot, childRel)));
    } else if (stat?.isFile) {
      out.push(childRel);
    }
  }
  return out;
}

/** Directory names that hold a direct SKILL.md, found by walking the tree. */
async function findSkillDirs(
  fs: FsPort,
  repoRoot: string,
  maxDepth: number,
): Promise<{ dirs: string[]; tooDeep: string[] }> {
  const dirs: string[] = [];
  const tooDeep: string[] = [];

  async function walk(rel: string, depth: number): Promise<void> {
    const abs = rel === '' ? repoRoot : `${repoRoot}/${rel}`;
    let entries: string[];
    try {
      entries = await fs.list(abs);
    } catch {
      return;
    }
    // A directory directly containing SKILL.md is a skill (unless it is a
    // reserved hooks directory, handled by the caller skipping descent).
    if (entries.includes(SKILL_FILE)) {
      if (depth >= 1 && depth <= maxDepth) {
        dirs.push(rel);
      } else if (depth > maxDepth) {
        tooDeep.push(rel);
      }
      // Do not descend into a skill's own subtree looking for more skills.
      return;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry : `${rel}/${entry}`;
      const stat = await fs.stat(`${repoRoot}/${childRel}`);
      if (stat?.isDirectory) {
        // hooks/ is reserved and never scanned for skill bodies.
        if (entry === HOOKS_DIR) continue;
        await walk(childRel, depth + 1);
      }
    }
  }

  await walk('', 0);
  return { dirs, tooDeep };
}

/** Build the SkillId for an auto-detected skill directory. */
function autoSkillId(rootPath: string): SkillId {
  const parts = rootPath.split('/');
  if (parts.length === 2) {
    return { group: parts[0], name: parts[1]! };
  }
  return { name: parts[0]! };
}

/** Resolve the hooks declared under a skill's `hooks/` directory. */
async function resolveHooks(
  fs: FsPort,
  repoRoot: string,
  skillRoot: string,
  warnings: string[],
): Promise<ResolvedHook[]> {
  const hooksRel = `${skillRoot}/${HOOKS_DIR}`;
  if (!(await fs.exists(`${repoRoot}/${hooksRel}`))) return [];
  const allFiles = await listFilesRec(fs, repoRoot, hooksRel);
  const manifestPaths = allFiles.filter((f) => f.endsWith(`/${HOOK_FILE}`));
  const hooks: ResolvedHook[] = [];

  for (const manifestPath of manifestPaths) {
    // The hook owns its directory subtree: the directory of the HOOK.md.
    const hookDir = manifestPath.slice(0, manifestPath.length - HOOK_FILE.length - 1);
    let manifest;
    try {
      manifest = parseHookManifest(await fs.readFile(`${repoRoot}/${manifestPath}`));
    } catch (err) {
      warnings.push(`Skipping invalid ${manifestPath}: ${(err as Error).message}`);
      continue;
    }
    const files = allFiles.filter((f) => f === manifestPath || f.startsWith(`${hookDir}/`)).sort();
    hooks.push({ manifest, manifestPath, files });
  }
  return hooks;
}

/** Build a ResolvedSkill from a directory known to contain SKILL.md. */
async function buildSkill(
  fs: FsPort,
  repoRoot: string,
  rootPath: string,
  id: SkillId,
  warnings: string[],
): Promise<ResolvedSkill | undefined> {
  let manifest;
  try {
    manifest = parseSkillManifest(await fs.readFile(`${repoRoot}/${rootPath}/${SKILL_FILE}`));
  } catch (err) {
    warnings.push(`Skipping invalid ${rootPath}/${SKILL_FILE}: ${(err as Error).message}`);
    return undefined;
  }
  const all = await listFilesRec(fs, repoRoot, rootPath);
  const hooksPrefix = `${rootPath}/${HOOKS_DIR}/`;
  const body = all.filter((f) => !f.startsWith(hooksPrefix)).sort();
  const hooks = await resolveHooks(fs, repoRoot, rootPath, warnings);
  return { id, rootPath, manifest, files: body, hooks };
}

/** Resolve skills declared explicitly in `skillkeeper.repo.yaml` (scheme 3). */
async function resolveFromConfig(
  fs: FsPort,
  repoRoot: string,
  configText: string,
  warnings: string[],
): Promise<ResolvedSkill[]> {
  let config;
  try {
    config = parseRepoConfig(configText);
  } catch (err) {
    const detail = err instanceof RepoConfigError ? err.message : (err as Error).message;
    warnings.push(`Ignoring ${REPO_CONFIG}: ${detail}`);
    return [];
  }

  const skills: ResolvedSkill[] = [];
  const defaultGroup = config.defaults?.group;

  if (config.skills !== undefined && config.skills.length > 0) {
    for (const entry of config.skills) {
      const skillMd = `${entry.path}/${SKILL_FILE}`;
      if (!(await fs.exists(`${repoRoot}/${skillMd}`))) {
        warnings.push(`Declared skill path "${entry.path}" has no ${SKILL_FILE}`);
        continue;
      }
      const base = await buildSkill(fs, repoRoot, entry.path, { name: 'placeholder' }, warnings);
      if (base === undefined) continue;
      const group = entry.group ?? defaultGroup;
      const name = entry.name ?? base.manifest.name;
      const id: SkillId = group === undefined ? { name } : { group, name };
      skills.push({ ...base, id });
    }
    return skills;
  }

  // No explicit list: auto-detect, then apply include/exclude filters.
  const { dirs } = await findSkillDirs(fs, repoRoot, 2);
  for (const dir of dirs) {
    if (config.include !== undefined && !matchesAny(dir, config.include)) continue;
    if (config.exclude !== undefined && matchesAny(dir, config.exclude)) continue;
    const base = await buildSkill(fs, repoRoot, dir, autoSkillId(dir), warnings);
    if (base === undefined) continue;
    const group = base.id.group ?? defaultGroup;
    const id: SkillId =
      group === undefined ? { name: base.id.name } : { group, name: base.id.name };
    skills.push({ ...base, id });
  }
  return skills;
}

/**
 * Resolve all skills in a checked-out repository working tree.
 *
 * Precedence: if `skillkeeper.repo.yaml` is present at the repo root it is
 * authoritative (scheme 3). Otherwise skills are auto-detected by locating
 * `SKILL.md` at depth 1 (scheme 1, flat) or depth 2 (scheme 2, grouped). A
 * directory is a skill if and only if it directly contains `SKILL.md`; the
 * `hooks/` subdirectory is reserved. A `SKILL.md` nested deeper than depth 2
 * (and not declared in config) yields an unresolved-path warning.
 *
 * @param fs Filesystem port.
 * @param repoRoot Working-tree root the returned paths are relative to.
 */
export async function resolveSkills(fs: FsPort, repoRoot: string): Promise<ResolveResult> {
  const warnings: string[] = [];

  const configPath = `${repoRoot}/${REPO_CONFIG}`;
  if (await fs.exists(configPath)) {
    const skills = await resolveFromConfig(fs, repoRoot, await fs.readFile(configPath), warnings);
    return { skills, warnings };
  }

  const { dirs, tooDeep } = await findSkillDirs(fs, repoRoot, 2);
  const skills: ResolvedSkill[] = [];
  for (const dir of dirs) {
    const skill = await buildSkill(fs, repoRoot, dir, autoSkillId(dir), warnings);
    if (skill !== undefined) skills.push(skill);
  }
  for (const deep of tooDeep) {
    warnings.push(
      `Unresolved ${SKILL_FILE} at "${deep}": nesting is deeper than a single group; ` +
        `declare it in ${REPO_CONFIG} to install it.`,
    );
  }
  return { skills, warnings };
}
