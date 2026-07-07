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
import type { AgentKind, AgentTarget, FsPort } from '@skillkeeper/core';
import { AdapterRegistry, loadState, saveState, resolveSkills, installSkill, uninstallSkill } from '@skillkeeper/core';
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

      // Removals first, so a re-install onto the same target starts clean.
      for (const ref of args.remove) {
        for (const agent of args.agents) {
          const manifest = installs.find(
            (m) => m.target.projectId === args.projectId && m.target.agent === agent && sameSkill(m, ref),
          );
          if (manifest !== undefined) {
            await uninstallSkill(deps.fs, manifest);
            installs = installs.filter((m) => m !== manifest);
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
              const env: AdapterHostEnv = {
                ...deps.adapterEnv,
                env: { ...deps.adapterEnv.env, [PROJECT_DIR_ENV]: args.projectPath },
              };
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
                sourcePath: resolved.rootPath,
              });
              installs.push(manifest);
            }
          }
          tick(ref.name);
        }
      }

      await saveState(deps.fs, deps.statePath, { ...state, installs });
      return { ok: true, installed: args.install.length, removed: args.remove.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
