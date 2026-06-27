/**
 * `skillkeeper repo` command group: add, remove, list, update.
 *
 * Repositories are persisted in the state store. Git operations (clone/fetch)
 * are delegated to the injected GitPort.
 */

import type { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import type { FsPort, GitPort } from '@skillkeeper/core';
import { loadState, saveState, repoHasUpdate } from '@skillkeeper/core';
import type { Translator } from '@skillkeeper/i18n';

interface RepoDeps {
  readonly fs: FsPort;
  readonly git: GitPort;
  readonly statePath: string;
  readonly t: Translator;
}

function detectKind(url: string): 'github' | 'bitbucket' | 'generic' {
  if (url.includes('github.com')) return 'github';
  if (url.includes('bitbucket.org')) return 'bitbucket';
  return 'generic';
}

function detectTransport(url: string): 'ssh' | 'https' {
  if (url.startsWith('git@') || url.startsWith('ssh://')) return 'ssh';
  return 'https';
}

export function registerRepoCommands(parent: Command, deps: RepoDeps): void {
  const repo = parent.command('repo').description('Manage skill repositories');

  // --- repo add ---
  repo
    .command('add <url> <localPath>')
    .description('Add and clone a skill repository')
    .option('--name <name>', 'Human-readable name for the repository')
    .option('--lfs', 'Enable Git LFS for this repository', false)
    .action(async (url: string, localPath: string, opts: { name?: string; lfs: boolean }) => {
      const { fs, git, statePath, t: _t } = deps;
      const state = await loadState(fs, statePath);
      const existing = state.repositories.find((r) => r.url === url || r.localPath === localPath);
      if (existing !== undefined) {
        console.error(`Repository already tracked (id: ${existing.id})`);
        process.exit(1);
      }
      await git.clone({ url, destination: localPath, lfs: opts.lfs });
      const id = randomUUID();
      const name = opts.name ?? url.split('/').pop()?.replace(/\.git$/, '') ?? id;
      const next = {
        ...state,
        repositories: [
          ...state.repositories,
          {
            id,
            name,
            url,
            kind: detectKind(url),
            transport: detectTransport(url),
            lfs: opts.lfs,
            localPath,
            lastFetched: new Date().toISOString(),
          },
        ],
      };
      await saveState(fs, statePath, next);
      console.log(`Repository added: ${name} (${id})`);
    });

  // --- repo remove ---
  repo
    .command('remove <id>')
    .description('Remove a tracked repository (does not delete the local clone)')
    .action(async (id: string) => {
      const { fs, statePath } = deps;
      const state = await loadState(fs, statePath);
      const repo = state.repositories.find((r) => r.id === id);
      if (repo === undefined) {
        console.error(`Repository not found: ${id}`);
        process.exit(1);
      }
      const next = {
        ...state,
        repositories: state.repositories.filter((r) => r.id !== id),
      };
      await saveState(fs, statePath, next);
      console.log(`Repository removed: ${repo.name}`);
    });

  // --- repo list ---
  repo
    .command('list')
    .description('List tracked repositories')
    .action(async () => {
      const { fs, statePath } = deps;
      const state = await loadState(fs, statePath);
      if (state.repositories.length === 0) {
        console.log('No repositories tracked.');
        return;
      }
      for (const r of state.repositories) {
        console.log(`${r.id}  ${r.name}  ${r.url}  (${r.localPath})`);
      }
    });

  // --- repo update ---
  repo
    .command('update [id]')
    .description('Update one repository or all repositories (--all)')
    .option('--all', 'Update all tracked repositories', false)
    .action(async (id: string | undefined, opts: { all: boolean }) => {
      const { fs, git, statePath } = deps;
      const state = await loadState(fs, statePath);
      const targets =
        opts.all
          ? state.repositories
          : state.repositories.filter((r) => r.id === id);
      if (targets.length === 0) {
        console.error(id !== undefined ? `Repository not found: ${id}` : 'No repositories tracked.');
        process.exit(1);
      }
      let anyError = false;
      const updated = state.repositories.map((r) => ({ ...r }));
      for (const repo of targets) {
        try {
          await git.pull(repo.localPath);
          const idx = updated.findIndex((r) => r.id === repo.id);
          if (idx !== -1) {
            updated[idx] = { ...repo, lastFetched: new Date().toISOString() };
          }
          console.log(`Updated: ${repo.name}`);
        } catch (err) {
          console.error(`Failed to update ${repo.name}: ${String(err)}`);
          anyError = true;
        }
      }
      await saveState(fs, statePath, { ...state, repositories: updated });
      if (anyError) process.exit(1);
    });

  // Internal helper used by check command -- exposed only as repoHasUpdate re-export.
  void repoHasUpdate; // keep import alive
}
