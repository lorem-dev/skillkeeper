import { matchesAny } from '../kernel/glob.js';
import { contentHash, hashTree, sha256, SKID_FILE } from '../kernel/hashing.js';
import { serializeSkid } from '../skills/skid.js';
import {
  encapsulateForeignDelimiters,
  insertRegion,
  removeRegion,
  wrapRegion,
} from '../hooks/hookRegion.js';
import {
  canonicalJson,
  encapsulateForeignMarkers,
  MARKER_FIELD,
  mergeHookNode,
  removeHookNode,
} from '../hooks/hookJson.js';
import type { AgentAdapter } from '../adapters/adapter.js';
import type {
  AgentTarget,
  InstallManifest,
  ManagedFile,
  ManagedHookEdit,
  ResolvedHook,
  ResolvedSkill,
  SkillId,
} from '../kernel/model.js';
import type { FsPort, HostEnv } from '../kernel/ports.js';

/** Options shared by install and repair. */
export interface InstallOptions {
  readonly fs: FsPort;
  readonly adapter: AgentAdapter;
  readonly target: AgentTarget;
  readonly env: HostEnv;
  /** Working-tree root the resolved skill paths are relative to. */
  readonly sourceRoot: string;
  readonly skill: ResolvedSkill;
  /** Whether to apply hooks (privileged; defaults to false). */
  readonly allowHooks?: boolean;
  /** Globs (relative to the skill root) marked executable after install. */
  readonly executableGlobs?: readonly string[];
  readonly sourceRepoId?: string;
  /** Source repository remote URL, recorded in the skill's `.skid.yml` and manifest. */
  readonly sourceRemote?: string;
  readonly sourcePath?: string;
  /** Injectable clock for the install timestamp (defaults to Date.now). */
  readonly now?: () => number;
}

/** Short, stable id derived from a hook's full label. */
function hookLabel(id: SkillId, hookName: string): string {
  const prefix = id.group === undefined ? id.name : `${id.group}/${id.name}`;
  return `${prefix}:${hookName}`;
}

function hookId(id: SkillId, hookName: string): string {
  return sha256(hookLabel(id, hookName)).slice(0, 12);
}

/** The payload file a hook ships (first non-HOOK.md file), if any. */
function hookPayloadPath(hook: ResolvedHook): string | undefined {
  return hook.files.find((f) => f !== hook.manifestPath);
}

/** Copy body files into the destination, returning recorded ManagedFile rows. */
async function copyBody(opts: InstallOptions, destRoot: string): Promise<ManagedFile[]> {
  const { fs, skill, sourceRoot } = opts;
  const skillDirName = skill.id.name;
  const declared = new Set(skill.manifest.executables ?? []);
  const globs = opts.executableGlobs ?? [];

  // Any `.skid.yml` in the source is dropped from the body; installSkill writes
  // its own authoritative identity file afterwards.
  const body = skill.files.filter((rel) => rel.slice(skill.rootPath.length + 1) !== SKID_FILE);

  for (const rel of body) {
    // rel is relative to repo root and starts with skill.rootPath.
    const within = rel.slice(skill.rootPath.length + 1); // path inside the skill
    const destRel = `${skillDirName}/${within}`;
    const content = await fs.readFile(`${sourceRoot}/${rel}`);
    await fs.writeFile(`${destRoot}/${destRel}`, content);
    const isExec = declared.has(within) || matchesAny(within, globs);
    if (isExec) {
      await fs.chmod(`${destRoot}/${destRel}`, true);
    }
  }

  const destRelPaths = body.map((rel) => `${skillDirName}/${rel.slice(skill.rootPath.length + 1)}`);
  return hashTree(fs, destRoot, destRelPaths);
}

/** Apply one hook edit; returns the recorded ManagedHookEdit, or undefined. */
async function applyHook(
  opts: InstallOptions,
  destRoot: string,
  hook: ResolvedHook,
): Promise<ManagedHookEdit | undefined> {
  const { fs, adapter, target, env, sourceRoot, skill } = opts;
  const support = adapter.hookSupport;
  if (support === undefined) return undefined;

  const payloadPath = hookPayloadPath(hook);
  const id = hookId(skill.id, hook.manifest.name);
  const label = hookLabel(skill.id, hook.manifest.name);

  if (support.strategy === 'delimited-text') {
    const targetFile = await support.resolveTargetFile(target, env);
    const raw = payloadPath === undefined ? '' : await fs.readFile(`${sourceRoot}/${payloadPath}`);
    const content = encapsulateForeignDelimiters(raw.replace(/\n$/, ''));
    const block = wrapRegion({
      commentToken: support.commentToken ?? '#',
      commentClose: support.commentClose,
      delimiterId: id,
      label,
      version: hook.manifest.version,
      content,
    });
    const existing = (await fs.exists(targetFile)) ? await fs.readFile(targetFile) : '';
    const next = insertRegion(existing, block, 'append');
    await fs.writeFile(targetFile, next);
    return { kind: 'delimited', file: targetFile, delimiterId: id, sha256: sha256(block) };
  }

  if (support.strategy === 'json-merge') {
    const targetFile = await support.resolveTargetFile(target, env);
    const keyPath = hook.manifest.target.keyPath ?? 'hooks';
    const rawNode =
      payloadPath === undefined ? '{}' : await fs.readFile(`${sourceRoot}/${payloadPath}`);
    const node = JSON.parse(encapsulateForeignMarkers(rawNode)) as Record<string, unknown>;
    const existing = (await fs.exists(targetFile)) ? await fs.readFile(targetFile) : '{}';
    const next = mergeHookNode(existing, keyPath, node, { markerId: id, label });
    await fs.writeFile(targetFile, next);
    // Hash the canonical owned node (marker included) so verify can recompute it
    // from the file and detect manual edits.
    const ownedNode = { ...node, [MARKER_FIELD]: { id, label } };
    const nodeHash = sha256(canonicalJson(ownedNode));
    return { kind: 'json', file: targetFile, keyPath, markerId: id, sha256: nodeHash };
  }

  // file strategy: copy the payload as a hook-owned standalone file.
  if (payloadPath === undefined) return undefined;
  const within = payloadPath.slice(`${skill.rootPath}/hooks/`.length);
  const destRel = `${skill.id.name}/hooks/${within}`;
  const content = await fs.readFile(`${sourceRoot}/${payloadPath}`);
  await fs.writeFile(`${destRoot}/${destRel}`, content);
  return { kind: 'file', relPath: destRel, sha256: sha256(content), executable: false };
}

/**
 * Install a skill body (and, only when `allowHooks` is true, its hooks) into the
 * adapter's destination for the target. Returns the {@link InstallManifest}
 * recording every managed file and hook edit.
 */
export async function installSkill(opts: InstallOptions): Promise<InstallManifest> {
  const { fs, adapter, target, env, skill } = opts;
  const destRoot = await adapter.destinationRoot(target, env);

  const bodyFiles = await copyBody(opts, destRoot);

  // Content hash over skill-relative body paths (dest prefix stripped), which is
  // stable across install locations and comparable to a repository skill's hash.
  const skillDirName = skill.id.name;
  const hash = contentHash(
    bodyFiles.map((f) => ({ relPath: f.relPath.slice(skillDirName.length + 1), sha256: f.sha256 })),
  );

  // Write our authoritative identity file, then record it as a managed file so
  // uninstall removes it and verify checks it.
  const skidRel = `${skillDirName}/${SKID_FILE}`;
  const skidText = serializeSkid({
    schema: 1,
    remote: opts.sourceRemote,
    name: skill.id.name,
    group: skill.id.group,
    version: hash,
  });
  await fs.writeFile(`${destRoot}/${skidRel}`, skidText);
  const files: ManagedFile[] = [
    ...bodyFiles,
    { relPath: skidRel, sha256: sha256(skidText), executable: false },
  ].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hookEdits: ManagedHookEdit[] = [];
  if (opts.allowHooks === true) {
    for (const hook of skill.hooks) {
      const edit = await applyHook(opts, destRoot, hook);
      if (edit !== undefined) hookEdits.push(edit);
    }
  }

  const now = (opts.now ?? Date.now)();
  return {
    skillId: skill.id,
    target,
    destinationRoot: destRoot,
    sourceRepoId: opts.sourceRepoId,
    sourceRemote: opts.sourceRemote,
    sourcePath: opts.sourcePath,
    contentHash: hash,
    version: skill.manifest.version,
    installedAt: new Date(now).toISOString(),
    files,
    hookEdits,
  };
}

/** Directory portion of a relative path, or '' when there is none. */
function dirOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx === -1 ? '' : rel.slice(0, idx);
}

/** Remove a file then prune now-empty ancestor directories up to destRoot. */
async function removeAndPrune(fs: FsPort, destRoot: string, relPath: string): Promise<void> {
  await fs.remove(`${destRoot}/${relPath}`);
  let dir = dirOf(relPath);
  while (dir !== '') {
    await fs.removeDirIfEmpty(`${destRoot}/${dir}`);
    dir = dirOf(dir);
  }
}

/**
 * Uninstall a skill: remove every recorded body file (pruning empty dirs) and
 * every recorded hook edit by its kind. Never touches unowned files or regions.
 */
export async function uninstallSkill(fs: FsPort, manifest: InstallManifest): Promise<void> {
  const destRoot = manifest.destinationRoot;
  for (const file of manifest.files) {
    await removeAndPrune(fs, destRoot, file.relPath);
  }
  for (const edit of manifest.hookEdits) {
    if (edit.kind === 'delimited') {
      if (await fs.exists(edit.file)) {
        const next = removeRegion(await fs.readFile(edit.file), edit.delimiterId);
        await fs.writeFile(edit.file, next);
      }
    } else if (edit.kind === 'json') {
      if (await fs.exists(edit.file)) {
        const next = removeHookNode(await fs.readFile(edit.file), edit.markerId);
        await fs.writeFile(edit.file, next);
      }
    } else {
      await removeAndPrune(fs, destRoot, edit.relPath);
    }
  }
}
