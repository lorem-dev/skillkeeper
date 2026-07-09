/**
 * Skill install/uninstall execution for the desktop main process, plus
 * project agent detection. Mirrors the CLI skill engine (packages/cli skill.ts):
 * resolve skills from tracked repos, then install/uninstall for each target
 * agent at project scope, persisting InstallManifests in the state store.
 *
 * Target convention: `target.projectId` is the project's UUID (so the desktop
 * can associate installs by id), while the agent path resolution reads the
 * project's real path from PROJECT_DIR_ENV.
 */
import path from 'node:path';
import type { AgentKind, AgentTarget, FsPort, InstallManifest, Project } from '@skillkeeper/core';
import {
  AdapterRegistry,
  loadState,
  saveState,
  resolveSkills,
  installSkill,
  uninstallSkill,
  hashTree,
  contentHash,
  normalizeRemote,
  parseSkid,
  SKID_FILE,
  guidanceKey,
  skillGuidanceId,
  upsertGuidanceBlock,
  removeGuidanceBlock,
  stripGuidanceMarkers,
} from '@skillkeeper/core';
import { registerBuiltinAgents, PROJECT_DIR_ENV } from '@skillkeeper/agents';
import type { AdapterHostEnv } from '@skillkeeper/agents';
import { loadConfig } from '@skillkeeper/config';
import { withStateLock } from './stateLock.js';

/** Files/dirs whose presence in a project marks an agent as having been used. */
const AGENT_MARKERS: Record<AgentKind, readonly string[]> = {
  claude: ['CLAUDE.md', '.claude'],
  codex: ['AGENTS.md', '.codex'],
  copilot: ['.github/copilot-instructions.md'],
  cursor: ['.cursor', '.cursorrules'],
  opencode: ['.opencode', 'opencode.json'],
};

/** Which agents appear to have been used in the project folder (by markers). */
export async function detectProjectAgents(fs: FsPort, projectPath: string): Promise<AgentKind[]> {
  const found: AgentKind[] = [];
  for (const [agent, markers] of Object.entries(AGENT_MARKERS) as [AgentKind, readonly string[]][]) {
    for (const marker of markers) {
      if (await fs.exists(path.join(projectPath, marker))) {
        found.push(agent);
        break;
      }
    }
  }
  return found;
}

/** A skill identified by its source repo and (group, name). */
export interface SkillRef {
  readonly repoId: string;
  readonly group?: string;
  readonly name: string;
}

export interface ApplyArgs {
  /** Project UUID (recorded as target.projectId). */
  readonly projectId: string;
  /** Project folder path (used for PROJECT_DIR_ENV path resolution). */
  readonly projectPath: string;
  readonly agents: readonly AgentKind[];
  readonly install: readonly SkillRef[];
  readonly remove: readonly SkillRef[];
}

export interface ApplyProgress {
  readonly done: number;
  readonly total: number;
  readonly label: string;
}

export type ApplyResult = { ok: true; installed: number; removed: number } | { ok: false; error: string };

export interface SkillsDeps {
  readonly fs: FsPort;
  readonly statePath: string;
  readonly configPath: string;
  readonly registry: AdapterRegistry;
  readonly adapterEnv: AdapterHostEnv;
}

/** Build the adapter registry with the built-in agents registered. */
export function createAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registerBuiltinAgents(registry);
  return registry;
}

const sameSkill = (
  m: { readonly sourceRepoId?: string; readonly skillId: { readonly group?: string; readonly name: string } },
  ref: SkillRef,
): boolean =>
  m.sourceRepoId === ref.repoId &&
  m.skillId.name === ref.name &&
  (m.skillId.group ?? '') === (ref.group ?? '');

/** Read a skill's guidance source (GUIDE.md wins over RULES.md), or undefined. */
async function readGuideBody(
  fs: FsPort,
  skillRoot: string, // absolute path of the skill dir in the repo checkout
): Promise<string | undefined> {
  for (const file of ['GUIDE.md', 'RULES.md']) {
    const p = `${skillRoot}/${file}`;
    if (await fs.exists(p)) return stripGuidanceMarkers(await fs.readFile(p)).replace(/\n+$/, '');
  }
  return undefined;
}

/** The guidance block key for a manifest / ref (remote + group/name). */
function guideKeyFor(remote: string, group: string | undefined, name: string): string {
  return guidanceKey(remote, skillGuidanceId(group, name));
}

/**
 * Apply a set of installs and removals for a project across the given agents,
 * reporting progress. Never throws across the IPC boundary; returns a result.
 */
export async function applySkillChanges(
  deps: SkillsDeps,
  args: ApplyArgs,
  onProgress: (p: ApplyProgress) => void,
): Promise<ApplyResult> {
  return withStateLock(async () => {
    try {
      const globs = (await loadConfig(deps.fs, deps.configPath)).config.executables.globs;
      const state = await loadState(deps.fs, deps.statePath);
      let installs = [...state.installs];

      const perSkill = Math.max(1, args.agents.length);
      const total = (args.install.length + args.remove.length) * perSkill;
      let done = 0;
      const tick = (label: string): void => {
        done += 1;
        onProgress({ done, total, label });
      };

      const adapterEnvFor = (_agent: AgentKind): AdapterHostEnv => ({
        ...deps.adapterEnv,
        env: { ...deps.adapterEnv.env, [PROJECT_DIR_ENV]: args.projectPath },
      });
      // key = guidance file path; value = map of blockKey -> body to upsert.
      const upserts = new Map<string, Map<string, string>>();
      // list of { file, blockKey } to remove unless still needed.
      const removals: { file: string; blockKey: string; agent: AgentKind }[] = [];

      // Removals first, so a re-install onto the same target starts clean.
      for (const ref of args.remove) {
        for (const agent of args.agents) {
          const manifest = installs.find(
            (m) => m.target.projectId === args.projectId && m.target.agent === agent && sameSkill(m, ref),
          );
          if (manifest !== undefined) {
            await uninstallSkill(deps.fs, manifest);
            installs = installs.filter((m) => m !== manifest);
            const remote = manifest.sourceRemote;
            if (remote !== undefined) {
              const file = await deps.registry
                .get(agent)
                .guidanceFile({ agent, scope: 'project', projectId: args.projectId }, adapterEnvFor(agent));
              removals.push({
                file,
                blockKey: guideKeyFor(remote, manifest.skillId.group, manifest.skillId.name),
                agent,
              });
            }
          }
          tick(ref.name);
        }
      }

      // Installs.
      for (const ref of args.install) {
        const repo = state.repositories.find((r) => r.id === ref.repoId);
        const resolved =
          repo !== undefined
            ? (await resolveSkills(deps.fs, repo.localPath)).skills.find(
                (s) => s.id.name === ref.name && (s.id.group ?? '') === (ref.group ?? ''),
              )
            : undefined;
        for (const agent of args.agents) {
          if (repo !== undefined && resolved !== undefined) {
            const already = installs.some(
              (m) => m.target.projectId === args.projectId && m.target.agent === agent && sameSkill(m, ref),
            );
            if (!already) {
              const adapter = deps.registry.get(agent);
              const env = adapterEnvFor(agent);
              const target: AgentTarget = { agent, scope: 'project', projectId: args.projectId };
              const manifest = await installSkill({
                fs: deps.fs,
                adapter,
                target,
                env,
                sourceRoot: repo.localPath,
                skill: resolved,
                allowHooks: false,
                executableGlobs: globs,
                sourceRepoId: repo.id,
                sourceRemote: repo.url,
                sourcePath: resolved.rootPath,
              });
              installs.push(manifest);
              const remote = repo.url;
              const body = await readGuideBody(deps.fs, `${repo.localPath}/${resolved.rootPath}`);
              if (body !== undefined) {
                const file = await adapter.guidanceFile(target, env);
                const blockKey = guideKeyFor(remote, resolved.id.group, resolved.id.name);
                const perFile = upserts.get(file) ?? new Map<string, string>();
                perFile.set(blockKey, body);
                upserts.set(file, perFile);
              }
            }
          }
          tick(ref.name);
        }
      }

      // Guidance blocks: apply upserts first, then removals that are not still
      // needed by a surviving install sharing the same guidance file.
      const finalKeysByFile = new Map<string, Set<string>>();
      for (const m of installs) {
        if (m.target.projectId !== args.projectId || m.sourceRemote === undefined) continue;
        const f = await deps.registry
          .get(m.target.agent)
          .guidanceFile(
            { agent: m.target.agent, scope: 'project', projectId: args.projectId },
            adapterEnvFor(m.target.agent),
          );
        const key = guideKeyFor(m.sourceRemote, m.skillId.group, m.skillId.name);
        const set = finalKeysByFile.get(f) ?? new Set<string>();
        set.add(key);
        finalKeysByFile.set(f, set);
      }

      for (const [file, blocks] of upserts) {
        let text = (await deps.fs.exists(file)) ? await deps.fs.readFile(file) : '';
        for (const [blockKey, body] of blocks) text = upsertGuidanceBlock(text, blockKey, body);
        await deps.fs.writeFile(file, text);
      }

      for (const { file, blockKey } of removals) {
        // Keep the block if a surviving install still needs it in this file.
        if (finalKeysByFile.get(file)?.has(blockKey) === true) continue;
        if (!(await deps.fs.exists(file))) continue;
        const next = removeGuidanceBlock(await deps.fs.readFile(file), blockKey);
        // Removing our only block empties a guidance file SkillKeeper created;
        // delete it rather than leaving a 0-byte file behind.
        if (next === '') await deps.fs.remove(file);
        else await deps.fs.writeFile(file, next);
      }

      await saveState(deps.fs, deps.statePath, { ...state, installs });
      return { ok: true, installed: args.install.length, removed: args.remove.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** List file paths (relative to `base`) recursively under `base/rel`. */
async function listFilesRec(fs: FsPort, base: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await fs.list(`${base}/${rel}`);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const childRel = `${rel}/${entry}`;
    const stat = await fs.stat(`${base}/${childRel}`);
    if (stat?.isDirectory === true) out.push(...(await listFilesRec(fs, base, childRel)));
    else if (stat?.isFile === true) out.push(childRel);
  }
  return out;
}

/** Adopt/refresh the manifest for one on-disk skill dir found during a scan. */
async function adoptSkill(
  fs: FsPort,
  destRoot: string,
  dirName: string,
  target: AgentTarget,
  rehome: (remote: string | undefined) => string | undefined,
  existing: InstallManifest | undefined,
): Promise<InstallManifest | undefined> {
  const skidPath = `${destRoot}/${dirName}/${SKID_FILE}`;
  const skid = (await fs.exists(skidPath)) ? parseSkid(await fs.readFile(skidPath)) : undefined;
  // A skill directory is identified by its SKILL.md; managed ones also carry a
  // `.skid.yml`. Directories without SKILL.md are not skills -- skip them.
  const isSkill = skid !== undefined || (await fs.exists(`${destRoot}/${dirName}/SKILL.md`));
  if (!isSkill) return undefined;

  const name = skid?.name ?? dirName;
  const group = skid?.group;
  const files = await hashTree(fs, destRoot, await listFilesRec(fs, destRoot, dirName));
  const prefix = `${name}/`;
  const hash = contentHash(
    files.map((f) => ({
      relPath: f.relPath.startsWith(prefix) ? f.relPath.slice(prefix.length) : f.relPath,
      sha256: f.sha256,
    })),
  );
  const remote = skid?.remote ?? existing?.sourceRemote;
  // With a known remote: re-home to a tracked repo sharing it (re-adoption after
  // a re-add) or keep the last-known id (a removed repo). Otherwise the skill is
  // "unmanaged" -- present in the project but not installed from a tracked repo;
  // the `''` sentinel places it at the repository level, grey and remove-only.
  const sourceRepoId = rehome(remote) ?? existing?.sourceRepoId ?? '';
  return {
    skillId: { name, group },
    target,
    destinationRoot: destRoot,
    sourceRepoId,
    sourceRemote: remote,
    sourcePath: existing?.sourcePath,
    contentHash: hash,
    version: existing?.version,
    installedAt: existing?.installedAt ?? new Date().toISOString(),
    files,
    hookEdits: existing?.hookEdits ?? [],
  };
}

/**
 * Reconcile project-scoped installs with what is actually on disk: scan each
 * tracked project's agent skill roots for `.skid.yml` skills, adopt untracked
 * ones into manifests, refresh `sourceRemote`/`contentHash`, re-home
 * `sourceRepoId` by remote, and prune manifests whose skill dir is gone.
 * Projects whose folder does not exist are left untouched (never pruned).
 * Returns the updated install list (also persisted when it changed).
 */
export async function reconcileProjectSkills(deps: SkillsDeps): Promise<InstallManifest[]> {
  return withStateLock(async () => {
    const state = await loadState(deps.fs, deps.statePath);
    const agents = Object.keys(AGENT_MARKERS) as AgentKind[];
    const trackedIds = new Set(state.projects.map((p) => p.id));
    const rehome = (remote: string | undefined): string | undefined => {
      if (remote === undefined) return undefined;
      const norm = normalizeRemote(remote);
      return state.repositories.find((r) => normalizeRemote(r.url) === norm)?.id;
    };

    const isProjectScoped = (m: InstallManifest): boolean =>
      m.target.scope === 'project' && m.target.projectId !== undefined && trackedIds.has(m.target.projectId);
    // Global installs and installs of untracked projects are preserved as-is.
    const kept: InstallManifest[] = state.installs.filter((m) => !isProjectScoped(m));

    for (const project of state.projects as Project[]) {
      const projInstalls = state.installs.filter(
        (m) => m.target.scope === 'project' && m.target.projectId === project.id,
      );
      if (!(await deps.fs.exists(project.path))) {
        kept.push(...projInstalls); // cannot scan -> keep every manifest
        continue;
      }
      for (const agent of agents) {
        const target: AgentTarget = { agent, scope: 'project', projectId: project.id };
        const env: AdapterHostEnv = {
          ...deps.adapterEnv,
          env: { ...deps.adapterEnv.env, [PROJECT_DIR_ENV]: project.path },
        };
        let destRoot: string;
        try {
          destRoot = await deps.registry.get(agent).destinationRoot(target, env);
        } catch {
          continue;
        }
        if (!(await deps.fs.exists(destRoot))) continue;
        let dirNames: string[];
        try {
          dirNames = await deps.fs.list(destRoot);
        } catch {
          continue;
        }
        for (const dirName of dirNames) {
          const existing = projInstalls.find(
            (m) => m.target.agent === agent && m.skillId.name === dirName,
          );
          const manifest = await adoptSkill(deps.fs, destRoot, dirName, target, rehome, existing);
          if (manifest !== undefined) kept.push(manifest);
        }
      }
    }

    if (JSON.stringify(kept) !== JSON.stringify(state.installs)) {
      await saveState(deps.fs, deps.statePath, { ...state, installs: kept });
    }
    return kept;
  });
}
