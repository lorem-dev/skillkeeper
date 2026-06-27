/**
 * `skillkeeper config` command group: validate, edit, path.
 */

import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import type { FsPort } from '@skillkeeper/core';
import { loadConfig } from '@skillkeeper/config';
import type { LoadConfigResult } from '@skillkeeper/config';
import type { Translator } from '@skillkeeper/i18n';

interface ConfigDeps {
  readonly fs: FsPort;
  readonly configFilePath: string;
  readonly t: Translator;
}

/**
 * Print a startup warning if any config section is invalid.
 * Called by main.ts after loading the config.
 */
export function printConfigWarning(result: LoadConfigResult, t: Translator): void {
  const invalid = Object.values(result.validity).includes('invalid');
  if (invalid) {
    console.warn(`[WARNING] ${t('config.invalidBanner')}`);
  }
}

export function registerConfigCommands(parent: Command, deps: ConfigDeps): void {
  const config = parent.command('config').description('Manage SkillKeeper configuration');

  // --- config validate ---
  config
    .command('validate')
    .description('Validate config.yaml and report per-section status')
    .action(async () => {
      const { fs, configFilePath, t } = deps;
      const result = await loadConfig(fs, configFilePath);
      let anyInvalid = false;
      for (const [section, status] of Object.entries(result.validity)) {
        if (status === 'invalid') {
          anyInvalid = true;
          console.log(`  INVALID: ${section}`);
        } else {
          console.log(`  ok:      ${section}`);
        }
      }
      for (const w of result.warnings) {
        console.warn(`  [WARNING] ${w}`);
      }
      if (anyInvalid) {
        console.warn(t('config.invalidBanner'));
        process.exit(1);
      } else {
        console.log('Configuration is valid.');
      }
    });

  // --- config edit ---
  config
    .command('edit')
    .description('Open config.yaml in the configured editor')
    .action(async () => {
      const { configFilePath } = deps;
      const editor =
        process.env['VISUAL'] ??
        process.env['EDITOR'] ??
        (process.platform === 'win32' ? 'notepad' : 'vi');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(editor, [configFilePath], { stdio: 'inherit', shell: false });
        child.on('close', (code) => {
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Editor exited with code ${String(code)}`));
          }
        });
        child.on('error', reject);
      });
    });

  // --- config path ---
  config
    .command('path')
    .description('Print the path to config.yaml')
    .action(() => {
      console.log(deps.configFilePath);
    });
}
