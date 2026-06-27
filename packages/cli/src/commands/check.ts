/**
 * `skillkeeper check` command: read-only update detection at repo and skill level.
 */

import type { Command } from 'commander';
import type { FsPort, GitPort } from '@skillkeeper/core';
import { loadState, repoHasUpdate, skillHasUpdate, resolveSkills } from '@skillkeeper/core';
import type { Translator } from '@skillkeeper/i18n';

interface CheckDeps {
  readonly fs: FsPort;
  readonly git: GitPort;
  readonly statePath: string;
  readonly t: Translator;
}

export function registerCheckCommands(parent: Command, deps: CheckDeps): void {
  parent
    .command('check')
    .description('Check for available updates (read-only)')
    .option('--all', 'Check all repositories and skills', false)
    .action(async (_opts: { all: boolean }) => {
      const { fs, git, statePath, t: _t } = deps;
      const state = await loadState(fs, statePath);

      if (state.repositories.length === 0) {
        console.log('No repositories to check.');
        return;
      }

      let anyUpdate = false;

      for (const repo of state.repositories) {
        let repoUpdate: boolean;
        try {
          repoUpdate = await repoHasUpdate(git, repo);
        } catch {
          console.warn(`  Could not check repo ${repo.name}: fetch failed`);
          continue;
        }

        if (repoUpdate) {
          anyUpdate = true;
          console.log(`UPDATE AVAILABLE: repository ${repo.name} (${repo.id})`);
        } else {
          console.log(`up to date: repository ${repo.name}`);
        }

        // Skill-level check.
        let resolveResult: Awaited<ReturnType<typeof resolveSkills>>;
        try {
          resolveResult = await resolveSkills(fs, repo.localPath);
        } catch {
          console.warn(`  Could not resolve skills in ${repo.name}`);
          continue;
        }

        for (const resolved of resolveResult.skills) {
          const relatedInstalls = state.installs.filter(
            (m) =>
              m.sourceRepoId === repo.id &&
              m.skillId.name === resolved.id.name &&
              m.skillId.group === resolved.id.group,
          );
          for (const manifest of relatedInstalls) {
            let hasUpdate: boolean;
            try {
              hasUpdate = await skillHasUpdate(fs, repo.localPath, resolved, manifest);
            } catch {
              console.warn(`  Could not check skill ${resolved.id.name}`);
              continue;
            }
            if (hasUpdate) {
              anyUpdate = true;
              console.log(
                `  UPDATE AVAILABLE: skill ${resolved.id.name} (${manifest.target.agent})`,
              );
            } else {
              console.log(`  up to date: skill ${resolved.id.name} (${manifest.target.agent})`);
            }
          }
        }
      }

      if (anyUpdate) process.exit(1);
    });
}
