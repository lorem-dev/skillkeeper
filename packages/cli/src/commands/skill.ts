/**
 * `skillkeeper skill` command group: list, info, install, uninstall, update,
 * verify, repair.
 *
 * Delegates to the core install / verify / repair engine and persists
 * InstallManifests in the state store.
 */

import type { Command } from 'commander';
import type { FsPort, GitPort, AgentKind, AgentTarget, ResolvedSkill } from '@skillkeeper/core';
import {
  loadState,
  saveState,
  resolveSkills,
  installSkill,
  uninstallSkill,
  verifyInstall,
  repairInstall,
} from '@skillkeeper/core';
import type { AdapterRegistry } from '@skillkeeper/core';
import type { Translator } from '@skillkeeper/i18n';
import { PROJECT_DIR_ENV } from '@skillkeeper/agents';
import type { AdapterHostEnv } from '@skillkeeper/agents';
import { cliMessage } from '../messages.js';

interface SkillDeps {
  readonly fs: FsPort;
  readonly git: GitPort;
  readonly statePath: string;
  readonly registry: AdapterRegistry;
  readonly t: Translator;
  /** Executable globs from config.executables.globs. */
  readonly executableGlobs: readonly string[];
  /** Env used by adapters (AdapterHostEnv). */
  readonly adapterEnv: AdapterHostEnv;
  /**
   * Resolve the current working directory. Injectable so tests can pin it
   * without relying on the test runner's cwd. Defaults to process.cwd in main.
   */
  readonly cwd: () => string;
}

/**
 * Resolve the adapter env and the AgentTarget for an operation, honoring scope.
 *
 * For a project-scope target the agents' path resolution requires
 * {@link PROJECT_DIR_ENV} to be set in the env it is handed. Production wiring
 * does not set it (the active project is a per-command concern, not a process
 * one), so it is injected here: from `--project` when given, otherwise the
 * current working directory. A project-scope op that cannot resolve a path
 * fails with a clear, localized error instead of relying on an unset env var.
 *
 * The resolved project path is also recorded as `target.projectId` so the
 * destination can be reconstructed by later operations.
 */
function resolveTarget(
  deps: SkillDeps,
  agent: AgentKind,
  global: boolean,
  projectOpt: string | undefined,
): { env: AdapterHostEnv; target: AgentTarget } {
  if (global) {
    return { env: deps.adapterEnv, target: { agent, scope: 'global' } };
  }
  const projectPath = projectOpt ?? deps.cwd();
  if (projectPath === undefined || projectPath.trim() === '') {
    throw new Error(cliMessage('cli.project.required'));
  }
  const env: AdapterHostEnv = {
    ...deps.adapterEnv,
    env: { ...deps.adapterEnv.env, [PROJECT_DIR_ENV]: projectPath },
  };
  return { env, target: { agent, scope: 'project', projectId: projectPath } };
}

export function registerSkillCommands(parent: Command, deps: SkillDeps): void {
  const skill = parent.command('skill').description('Manage skills');

  // --- skill list ---
  skill
    .command('list')
    .description('List installed skills')
    .action(async () => {
      const { fs, statePath, t } = deps;
      const state = await loadState(fs, statePath);
      if (state.installs.length === 0) {
        console.log('No skills installed.');
        return;
      }
      console.log(t('skills.count', { n: String(state.installs.length) }));
      for (const m of state.installs) {
        const id = m.skillId.group !== undefined
          ? `${m.skillId.group}/${m.skillId.name}`
          : m.skillId.name;
        console.log(`  ${id}  agent=${m.target.agent}  scope=${m.target.scope}${m.version !== undefined ? `  v${m.version}` : ''}`);
      }
    });

  // --- skill info <id> ---
  skill
    .command('info <id>')
    .description('Show details for an installed skill')
    .action(async (id: string) => {
      const { fs, statePath } = deps;
      const state = await loadState(fs, statePath);
      const matches = state.installs.filter((m) => {
        const fullId = m.skillId.group !== undefined
          ? `${m.skillId.group}/${m.skillId.name}`
          : m.skillId.name;
        return fullId === id || m.skillId.name === id;
      });
      if (matches.length === 0) {
        console.error(`Skill not found: ${id}`);
        process.exit(1);
      }
      for (const m of matches) {
        console.log(`Skill:    ${m.skillId.name}`);
        if (m.skillId.group !== undefined) console.log(`Group:    ${m.skillId.group}`);
        if (m.version !== undefined) console.log(`Version:  ${m.version}`);
        console.log(`Agent:    ${m.target.agent}  scope=${m.target.scope}`);
        console.log(`Dest:     ${m.destinationRoot}`);
        console.log(`Installed: ${m.installedAt}`);
        console.log(`Files:    ${m.files.length}`);
        console.log(`Hooks:    ${m.hookEdits.length}`);
      }
    });

  // --- skill install <id> ---
  skill
    .command('install <id>')
    .description('Install a skill for an agent')
    .requiredOption('--agent <agent>', 'Agent to install for (claude|codex|copilot|cursor|opencode)')
    .option('--global', 'Install globally (default: project scope)', false)
    .option('--project <path>', 'Project directory for project scope (default: cwd)')
    .option('--allow-hooks', 'Also install hooks (requires explicit consent)', false)
    .action(async (
      id: string,
      opts: { agent: string; global: boolean; project?: string; allowHooks: boolean },
    ) => {
      const { fs, statePath, registry, executableGlobs, t } = deps;
      const state = await loadState(fs, statePath);

      // Find the skill in tracked repositories.
      let foundSkill: ResolvedSkill | undefined;
      let sourceRoot: string | undefined;
      let sourceRepoId: string | undefined;

      for (const repo of state.repositories) {
        const result = await resolveSkills(fs, repo.localPath);
        for (const resolved of result.skills) {
          const fullId = resolved.id.group !== undefined
            ? `${resolved.id.group}/${resolved.id.name}`
            : resolved.id.name;
          if (fullId === id || resolved.id.name === id) {
            foundSkill = resolved;
            sourceRoot = repo.localPath;
            sourceRepoId = repo.id;
            break;
          }
        }
        if (foundSkill !== undefined) break;
      }

      if (foundSkill === undefined || sourceRoot === undefined) {
        console.error(`Skill not found in any tracked repository: ${id}`);
        process.exit(1);
      }

      const agentKind = opts.agent as AgentKind;
      const adapter = registry.get(agentKind);
      const { env, target } = resolveTarget(deps, agentKind, opts.global, opts.project);

      const manifest = await installSkill({
        fs,
        adapter,
        target,
        env,
        sourceRoot,
        skill: foundSkill,
        allowHooks: opts.allowHooks,
        executableGlobs,
        sourceRepoId,
        sourcePath: foundSkill.rootPath,
      });

      const next = {
        ...state,
        installs: [...state.installs, manifest],
      };
      await saveState(fs, statePath, next);

      const skillLabel = foundSkill.id.group !== undefined
        ? `${foundSkill.id.group}/${foundSkill.id.name}`
        : foundSkill.id.name;

      if (!opts.allowHooks && foundSkill.hooks.length > 0) {
        console.log(t('hooks.requireConsent'));
      }
      console.log(`Skill installed: ${skillLabel} -> ${manifest.destinationRoot}`);
    });

  // --- skill uninstall <id> ---
  skill
    .command('uninstall <id>')
    .description('Uninstall a skill')
    .option('--agent <agent>', 'Limit to a specific agent')
    .action(async (id: string, opts: { agent?: string }) => {
      const { fs, statePath } = deps;
      const state = await loadState(fs, statePath);
      const matches = state.installs.filter((m) => {
        const fullId = m.skillId.group !== undefined
          ? `${m.skillId.group}/${m.skillId.name}`
          : m.skillId.name;
        const idMatch = fullId === id || m.skillId.name === id;
        if (opts.agent !== undefined) return idMatch && m.target.agent === opts.agent;
        return idMatch;
      });
      if (matches.length === 0) {
        console.error(`Skill not found: ${id}`);
        process.exit(1);
      }
      for (const m of matches) {
        await uninstallSkill(fs, m);
        console.log(`Uninstalled: ${m.skillId.name} (${m.target.agent})`);
      }
      const matchSet = new Set(matches);
      const next = {
        ...state,
        installs: state.installs.filter((m) => !matchSet.has(m)),
      };
      await saveState(fs, statePath, next);
    });

  // --- skill update <id> ---
  skill
    .command('update <id>')
    .description('Update an installed skill to the latest source')
    .option('--agent <agent>', 'Limit to a specific agent')
    .option('--project <path>', 'Project directory for project-scope installs (default: recorded path or cwd)')
    .option('--allow-hooks', 'Re-apply hooks during update (requires consent)', false)
    .action(async (id: string, opts: { agent?: string; project?: string; allowHooks: boolean }) => {
      const { fs, statePath, registry, executableGlobs, t } = deps;
      const state = await loadState(fs, statePath);
      const matches = state.installs.filter((m) => {
        const fullId = m.skillId.group !== undefined
          ? `${m.skillId.group}/${m.skillId.name}`
          : m.skillId.name;
        const idMatch = fullId === id || m.skillId.name === id;
        if (opts.agent !== undefined) return idMatch && m.target.agent === opts.agent;
        return idMatch;
      });
      if (matches.length === 0) {
        console.error(`Skill not found: ${id}`);
        process.exit(1);
      }
      let updatedInstalls = [...state.installs];
      for (const m of matches) {
        const repo = state.repositories.find((r) => r.id === m.sourceRepoId);
        if (repo === undefined) {
          console.error(`Source repository not found for skill: ${m.skillId.name}`);
          continue;
        }
        const result = await resolveSkills(fs, repo.localPath);
        const resolved = result.skills.find((s) => {
          const fullId = s.id.group !== undefined
            ? `${s.id.group}/${s.id.name}`
            : s.id.name;
          return fullId === id || s.id.name === id;
        });
        if (resolved === undefined) {
          console.error(`Skill not found in source: ${id}`);
          continue;
        }
        const adapter = registry.get(m.target.agent);
        const isGlobal = m.target.scope === 'global';
        const projectHint = opts.project ?? m.target.projectId;
        const { env, target } = resolveTarget(deps, m.target.agent, isGlobal, projectHint);
        await uninstallSkill(fs, m);
        const newManifest = await installSkill({
          fs,
          adapter,
          target,
          env,
          sourceRoot: repo.localPath,
          skill: resolved,
          allowHooks: opts.allowHooks,
          executableGlobs,
          sourceRepoId: repo.id,
          sourcePath: resolved.rootPath,
        });
        updatedInstalls = updatedInstalls.filter((i) => i !== m);
        updatedInstalls.push(newManifest);
        if (!opts.allowHooks && resolved.hooks.length > 0) {
          console.log(t('hooks.requireConsent'));
        }
        console.log(`Updated: ${m.skillId.name} (${m.target.agent})`);
      }
      await saveState(fs, statePath, { ...state, installs: updatedInstalls });
    });

  // --- skill verify <id> ---
  skill
    .command('verify <id>')
    .description('Verify integrity of an installed skill')
    .option('--agent <agent>', 'Limit to a specific agent')
    .action(async (id: string, opts: { agent?: string }) => {
      const { fs, statePath } = deps;
      const state = await loadState(fs, statePath);
      const matches = state.installs.filter((m) => {
        const fullId = m.skillId.group !== undefined
          ? `${m.skillId.group}/${m.skillId.name}`
          : m.skillId.name;
        const idMatch = fullId === id || m.skillId.name === id;
        if (opts.agent !== undefined) return idMatch && m.target.agent === opts.agent;
        return idMatch;
      });
      if (matches.length === 0) {
        console.error(`Skill not found: ${id}`);
        process.exit(1);
      }
      let anyProblem = false;
      for (const m of matches) {
        const report = await verifyInstall(fs, m);
        if (report.ok) {
          console.log(`OK: ${m.skillId.name} (${m.target.agent})`);
        } else {
          anyProblem = true;
          console.log(`FAIL: ${m.skillId.name} (${m.target.agent})`);
          for (const f of report.files) {
            if (f.status !== 'ok') {
              console.log(`  file ${f.status}: ${f.relPath}`);
            }
          }
          for (const h of report.hookEdits) {
            if (h.status !== 'ok') {
              console.log(`  hook ${h.status}: ${h.edit.kind}`);
            }
          }
        }
      }
      if (anyProblem) process.exit(1);
    });

  // --- skill repair <id> ---
  skill
    .command('repair <id>')
    .description('Repair a drifted skill installation')
    .option('--agent <agent>', 'Limit to a specific agent')
    .option('--project <path>', 'Project directory for project-scope installs (default: recorded path or cwd)')
    .option('--allow-hooks', 'Re-apply hooks during repair (requires consent)', false)
    .action(async (id: string, opts: { agent?: string; project?: string; allowHooks: boolean }) => {
      const { fs, statePath, registry, executableGlobs, t } = deps;
      const state = await loadState(fs, statePath);
      const matches = state.installs.filter((m) => {
        const fullId = m.skillId.group !== undefined
          ? `${m.skillId.group}/${m.skillId.name}`
          : m.skillId.name;
        const idMatch = fullId === id || m.skillId.name === id;
        if (opts.agent !== undefined) return idMatch && m.target.agent === opts.agent;
        return idMatch;
      });
      if (matches.length === 0) {
        console.error(`Skill not found: ${id}`);
        process.exit(1);
      }
      let updatedInstalls = [...state.installs];
      for (const m of matches) {
        const repo = state.repositories.find((r) => r.id === m.sourceRepoId);
        if (repo === undefined) {
          console.error(`Source repository not found for: ${m.skillId.name}`);
          continue;
        }
        const result = await resolveSkills(fs, repo.localPath);
        const resolved = result.skills.find((s) => {
          const fullId = s.id.group !== undefined
            ? `${s.id.group}/${s.id.name}`
            : s.id.name;
          return fullId === id || s.id.name === id;
        });
        if (resolved === undefined) {
          console.error(`Skill not found in source: ${id}`);
          continue;
        }
        const adapter = registry.get(m.target.agent);
        const isGlobal = m.target.scope === 'global';
        const projectHint = opts.project ?? m.target.projectId;
        const { env, target } = resolveTarget(deps, m.target.agent, isGlobal, projectHint);
        const newManifest = await repairInstall({
          fs,
          adapter,
          target,
          env,
          sourceRoot: repo.localPath,
          skill: resolved,
          allowHooks: opts.allowHooks,
          executableGlobs,
          sourceRepoId: repo.id,
          sourcePath: resolved.rootPath,
          manifest: m,
        });
        updatedInstalls = updatedInstalls.map((i) => (i === m ? newManifest : i));
        if (!opts.allowHooks && resolved.hooks.length > 0) {
          console.log(t('hooks.requireConsent'));
        }
        console.log(`Repaired: ${m.skillId.name} (${m.target.agent})`);
      }
      await saveState(fs, statePath, { ...state, installs: updatedInstalls });
    });
}
