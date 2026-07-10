/**
 * CLI entry point for SkillKeeper.
 *
 * Startup sequence:
 *  1. Resolve app-data paths.
 *  2. Load config.yaml (invalid sections fall back to defaults).
 *  3. Print a localized warning if any section is invalid.
 *  4. Wire real ports.
 *  5. Register all command groups.
 *  6. Parse argv.
 */

import { Command } from 'commander';
import { createNodeFs } from '@skillkeeper/core';
import { loadConfig } from '@skillkeeper/config';
import { createTranslator } from '@skillkeeper/i18n';
import { appDataDir, configPath, statePath } from './paths.js';
import { createWiring } from './wiring.js';
import { printConfigWarning } from './commands/config.js';
import { registerRepoCommands } from './commands/repo.js';
import { registerSkillCommands } from './commands/skill.js';
import { registerProjectCommands } from './commands/project.js';
import { registerConfigCommands } from './commands/config.js';
import { registerCheckCommands } from './commands/check.js';
import { registerMcpCommands } from './commands/mcp.js';

async function main(): Promise<void> {
  const dataDir = appDataDir();
  const cfgPath = configPath(dataDir);
  const stPath = statePath(dataDir);

  // Load config with a bare NodeFs before wiring (wiring itself needs the config).
  const bareFs = createNodeFs();
  const configResult = await loadConfig(bareFs, cfgPath);

  // Bootstrap a minimal translator for the startup warning (config may be invalid).
  const bootLang = configResult.config.general.language;
  const bootT = createTranslator(bootLang);

  printConfigWarning(configResult, bootT);

  const wiring = createWiring(configResult.config);

  const program = new Command('skillkeeper')
    .version('0.0.0')
    .description('Manage skills for AI coding agents');

  registerRepoCommands(program, {
    fs: wiring.fs,
    git: wiring.git,
    statePath: stPath,
    t: wiring.t,
  });

  registerSkillCommands(program, {
    fs: wiring.fs,
    git: wiring.git,
    statePath: stPath,
    registry: wiring.registry,
    adapterEnv: wiring.adapterEnv,
    executableGlobs: configResult.config.executables.globs,
    cwd: () => process.cwd(),
    t: wiring.t,
  });

  registerProjectCommands(program, {
    fs: wiring.fs,
    statePath: stPath,
    t: wiring.t,
  });

  registerConfigCommands(program, {
    fs: wiring.fs,
    configFilePath: cfgPath,
    t: wiring.t,
  });

  registerCheckCommands(program, {
    fs: wiring.fs,
    git: wiring.git,
    statePath: stPath,
    t: wiring.t,
  });

  registerMcpCommands(program, {
    fs: wiring.fs,
    statePath: stPath,
    registry: wiring.registry,
    adapterEnv: wiring.adapterEnv,
    t: wiring.t,
    manualPresets: configResult.config.mcp.servers,
    cwd: () => process.cwd(),
  });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(String(err));
  process.exit(1);
});
