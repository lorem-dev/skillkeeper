/**
 * Compose the real I/O ports and infrastructure for the CLI.
 *
 * This module is the only place in the CLI that touches Node APIs directly
 * (besides paths.ts and main.ts). All other modules receive injected ports.
 */

import { homedir } from 'node:os';

import { AdapterRegistry, createNodeFs, createSystemGit } from '@skillkeeper/core';
import type { FsPort, GitPort, HostEnv } from '@skillkeeper/core';
import { registerBuiltinAgents } from '@skillkeeper/agents';
import type { AdapterHostEnv } from '@skillkeeper/agents';
import { createTranslator } from '@skillkeeper/i18n';
import type { Translator } from '@skillkeeper/i18n';
import type { SkillKeeperConfig } from '@skillkeeper/config';

/** All wired-up real ports for a CLI session. */
export interface Wiring {
  readonly fs: FsPort;
  readonly git: GitPort;
  readonly env: HostEnv;
  readonly adapterEnv: AdapterHostEnv;
  readonly registry: AdapterRegistry;
  readonly t: Translator;
}

/**
 * Build a fully-wired set of real ports for a CLI run.
 *
 * @param config Loaded configuration (used to determine language for i18n).
 */
export function createWiring(config: SkillKeeperConfig): Wiring {
  const fs = createNodeFs();

  const env: HostEnv = {
    homeDir: homedir(),
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
  };

  const git = createSystemGit(env);

  const adapterEnv: AdapterHostEnv = {
    ...env,
    fs,
  };

  const registry = new AdapterRegistry();
  registerBuiltinAgents(registry);

  const t = createTranslator(config.general.language);

  return { fs, git, env, adapterEnv, registry, t };
}
