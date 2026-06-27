/**
 * Unit tests for the CLI command logic.
 *
 * (a) Startup config-validity warning path.
 * (b) `skill install` without --allow-hooks reports hooks skipped.
 *
 * These tests do not spawn a real process; they call the helper functions and
 * command handlers directly so no real network or git is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createMemFs } from '@skillkeeper/core/testing';
import { createFakeGit } from '@skillkeeper/core/testing';
import { createTranslator } from '@skillkeeper/i18n';
import { emptyState, saveState, AdapterRegistry } from '@skillkeeper/core';
import { registerBuiltinAgents } from '@skillkeeper/agents';
import type { AdapterHostEnv } from '@skillkeeper/agents';
import { printConfigWarning } from './config.js';
import { registerSkillCommands } from './skill.js';
import type { LoadConfigResult } from '@skillkeeper/config';
import { defaultConfig } from '@skillkeeper/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registerBuiltinAgents(registry);
  return registry;
}

// ---------------------------------------------------------------------------
// (a) Config-validity warning path
// ---------------------------------------------------------------------------

describe('printConfigWarning', () => {
  it('prints a warning when any section is invalid', () => {
    const t = createTranslator('en');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result: LoadConfigResult = {
      config: { ...defaultConfig },
      validity: {
        general: 'valid',
        updates: 'invalid',
        agents: 'valid',
        executables: 'valid',
        security: 'valid',
        notifications: 'valid',
      },
      warnings: ['Config section "updates" is invalid; using defaults.'],
    };

    printConfigWarning(result, t);

    expect(warn).toHaveBeenCalledOnce();
    const call = warn.mock.calls[0];
    const message: string = call !== undefined && call[0] !== undefined ? String(call[0]) : '';
    expect(message).toContain('invalid');
    warn.mockRestore();
  });

  it('prints nothing when all sections are valid', () => {
    const t = createTranslator('en');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result: LoadConfigResult = {
      config: { ...defaultConfig },
      validity: {
        general: 'valid',
        updates: 'valid',
        agents: 'valid',
        executables: 'valid',
        security: 'valid',
        notifications: 'valid',
      },
      warnings: [],
    };

    printConfigWarning(result, t);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// (b) skill install without --allow-hooks reports hooks skipped
// ---------------------------------------------------------------------------

describe('skill install (hooks consent)', () => {
  const STATE_PATH = '/state/state.json';
  const REPO_LOCAL_PATH = '/repos/myrepo';

  let consoleLogs: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogs = [];
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      consoleLogs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  async function runInstall(allowHooks: boolean): Promise<void> {
    // Build a fake fs seeded with the repo files needed for skill resolution.
    const fs = createMemFs({
      [`${REPO_LOCAL_PATH}/testskill/SKILL.md`]:
        '---\nname: testskill\nversion: 1.0.0\nhooks:\n  - pre-edit\n---\nTest.',
      [`${REPO_LOCAL_PATH}/testskill/run.sh`]: '#!/bin/sh\necho hi',
      [`${REPO_LOCAL_PATH}/testskill/hooks/pre-edit/HOOK.md`]:
        '---\nname: pre-edit\ntarget:\n  agent: claude\n  keyPath: hooks.PreToolUse\nstrategy: json-merge\n---',
    });

    const state = emptyState();
    const repoId = 'repo-1';
    const stateWithRepo = {
      ...state,
      repositories: [
        {
          id: repoId,
          name: 'myrepo',
          url: 'https://github.com/example/myrepo',
          kind: 'github' as const,
          transport: 'https' as const,
          lfs: false,
          localPath: REPO_LOCAL_PATH,
        },
      ],
    };
    await saveState(fs, STATE_PATH, stateWithRepo);

    const registry = makeRegistry();
    const adapterEnv: AdapterHostEnv = {
      homeDir: '/home/testuser',
      platform: 'linux',
      env: {
        SKILLKEEPER_PROJECT_DIR: '/projects/myproject',
      } as Record<string, string | undefined>,
      fs,
    };

    const t = createTranslator('en');
    const git = createFakeGit();

    const program = new Command('skillkeeper-test').exitOverride();
    registerSkillCommands(program, {
      fs,
      git,
      statePath: STATE_PATH,
      registry,
      adapterEnv,
      executableGlobs: [],
      t,
    });

    // Intercept process.exit so tests don't terminate the runner.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null) => {
        throw new Error(`process.exit(${String(_code)})`);
      });

    try {
      await program.parseAsync([
        'node',
        'skillkeeper',
        'skill',
        'install',
        'testskill',
        '--agent',
        'claude',
        ...(allowHooks ? ['--allow-hooks'] : []),
      ]);
    } finally {
      exitSpy.mockRestore();
    }
  }

  it('prints hooks-skipped notice when --allow-hooks is absent and skill has hooks', async () => {
    await runInstall(false);
    const noticed = consoleLogs.some(
      (line) => line.toLowerCase().includes('hook') && line.toLowerCase().includes('skip'),
    );
    expect(noticed).toBe(true);
  });

  it('does NOT print hooks-skipped notice when --allow-hooks is present', async () => {
    await runInstall(true);
    const noticed = consoleLogs.some(
      (line) => line.toLowerCase().includes('hook') && line.toLowerCase().includes('skip'),
    );
    expect(noticed).toBe(false);
  });
});
