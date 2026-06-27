/**
 * `skillkeeper project` command group: add, remove, list.
 *
 * Projects are tracked project directories persisted in the state store.
 */

import type { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import type { FsPort } from '@skillkeeper/core';
import { loadState, saveState } from '@skillkeeper/core';
import type { Translator } from '@skillkeeper/i18n';

interface ProjectDeps {
  readonly fs: FsPort;
  readonly statePath: string;
  readonly t: Translator;
}

export function registerProjectCommands(parent: Command, deps: ProjectDeps): void {
  const project = parent.command('project').description('Manage tracked projects');

  // --- project add ---
  project
    .command('add <path>')
    .description('Track a project directory')
    .option('--name <name>', 'Human-readable name for the project')
    .action(async (projectPath: string, opts: { name?: string }) => {
      const { fs, statePath } = deps;
      const state = await loadState(fs, statePath);
      const existing = state.projects.find((p) => p.path === projectPath);
      if (existing !== undefined) {
        console.error(`Project already tracked (id: ${existing.id})`);
        process.exit(1);
      }
      const id = randomUUID();
      const name = opts.name ?? projectPath.split('/').pop() ?? id;
      const next = {
        ...state,
        projects: [
          ...state.projects,
          {
            id,
            path: projectPath,
            name,
            addedAt: new Date().toISOString(),
          },
        ],
      };
      await saveState(fs, statePath, next);
      console.log(`Project added: ${name} (${id})`);
    });

  // --- project remove ---
  project
    .command('remove <id>')
    .description('Stop tracking a project directory')
    .action(async (id: string) => {
      const { fs, statePath } = deps;
      const state = await loadState(fs, statePath);
      const proj = state.projects.find((p) => p.id === id);
      if (proj === undefined) {
        console.error(`Project not found: ${id}`);
        process.exit(1);
      }
      const next = {
        ...state,
        projects: state.projects.filter((p) => p.id !== id),
      };
      await saveState(fs, statePath, next);
      console.log(`Project removed: ${proj.name}`);
    });

  // --- project list ---
  project
    .command('list')
    .description('List tracked projects')
    .action(async () => {
      const { fs, statePath } = deps;
      const state = await loadState(fs, statePath);
      if (state.projects.length === 0) {
        console.log('No projects tracked.');
        return;
      }
      for (const p of state.projects) {
        console.log(`${p.id}  ${p.name}  ${p.path}`);
      }
    });

  void deps.t; // keep import alive
}
