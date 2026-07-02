import { describe, it, expect } from 'vitest';
import { createMemFs } from '@skillkeeper/core/testing';
import { loadConfig, saveConfig, defaultConfig } from './load.js';

const VALID_YAML = `
general:
  language: de
  theme: dark
  defaultEditor: code

updates:
  mode: scheduled
  intervalHours: 12
  checkOnStartup: true

agents:
  enabled:
    - claude
    - codex
  overrides:
    claude:
      skillsDir: ~/.custom/skills

executables:
  globs:
    - "*.sh"
    - "bin/*"

security:
  hookConsentPolicy: always-ask

notifications:
  enabled: true

repositories:
  gitPath: /usr/bin/git
`.trim();

const CONFIG_PATH = '/home/user/.config/skillkeeper/config.yaml';

describe('loadConfig', () => {
  it('loads a fully valid file with all sections valid', async () => {
    const fs = createMemFs({ [CONFIG_PATH]: VALID_YAML });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.config.general.language).toBe('de');
    expect(result.config.updates.intervalHours).toBe(12);
    expect(result.config.agents.enabled).toEqual(['claude', 'codex']);
    expect(result.config.executables.globs).toEqual(['*.sh', 'bin/*']);
    expect(result.config.security.hookConsentPolicy).toBe('always-ask');
    expect(result.config.notifications.enabled).toBe(true);
    expect(result.config.repositories.gitPath).toBe('/usr/bin/git');

    expect(result.validity.general).toBe('valid');
    expect(result.validity.updates).toBe('valid');
    expect(result.validity.agents).toBe('valid');
    expect(result.validity.executables).toBe('valid');
    expect(result.validity.security).toBe('valid');
    expect(result.validity.notifications).toBe('valid');
    expect(result.validity.repositories).toBe('valid');

    expect(result.warnings).toHaveLength(0);
  });

  it('replaces an invalid section with its default, leaves other sections intact, and adds a warning', async () => {
    const badYaml = `
general:
  language: de

updates:
  mode: manual
  intervalHours: -999

agents:
  enabled:
    - claude

executables:
  globs: []

security:
  hookConsentPolicy: always-ask

notifications:
  enabled: false
`.trim();

    const fs = createMemFs({ [CONFIG_PATH]: badYaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    // Invalid section falls back to default
    expect(result.validity.updates).toBe('invalid');
    expect(result.config.updates.intervalHours).toBe(defaultConfig.updates.intervalHours);

    // Other sections remain as parsed
    expect(result.validity.general).toBe('valid');
    expect(result.config.general.language).toBe('de');
    expect(result.validity.agents).toBe('valid');
    expect(result.validity.executables).toBe('valid');
    expect(result.validity.security).toBe('valid');
    expect(result.validity.notifications).toBe('valid');
    expect(result.validity.repositories).toBe('valid');

    // A warning is added for the invalid section
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.includes('updates'))).toBe(true);

    // The file on disk is NOT rewritten
    const raw = await fs.readFile(CONFIG_PATH);
    expect(raw).toContain('intervalHours: -999');
  });

  it('returns full defaults when the file does not exist', async () => {
    const fs = createMemFs({});
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.config).toEqual(defaultConfig);
    expect(Object.values(result.validity).every((v) => v === 'valid')).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('handles a completely invalid YAML file gracefully (all sections invalid)', async () => {
    const fs = createMemFs({ [CONFIG_PATH]: 'general: [invalid yaml structure' });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.config).toEqual(defaultConfig);
    expect(Object.values(result.validity).every((v) => v === 'invalid')).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('handles a file where only one section is present (others get defaults)', async () => {
    const partialYaml = 'general:\n  language: ru\n';
    const fs = createMemFs({ [CONFIG_PATH]: partialYaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.validity.general).toBe('valid');
    expect(result.config.general.language).toBe('ru');

    // Missing sections get defaults and are marked valid
    expect(result.validity.updates).toBe('valid');
    expect(result.config.updates).toEqual(defaultConfig.updates);
  });

  it('marks general section invalid when language is an unknown value', async () => {
    const yaml = 'general:\n  language: fr\n';
    const fs = createMemFs({ [CONFIG_PATH]: yaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.validity.general).toBe('invalid');
    expect(result.config.general).toEqual(defaultConfig.general);
    expect(result.warnings.some((w) => w.includes('general'))).toBe(true);
  });

  it('marks agents section invalid when enabled contains an unknown agent kind', async () => {
    const yaml = 'agents:\n  enabled:\n    - unknownagent\n';
    const fs = createMemFs({ [CONFIG_PATH]: yaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.validity.agents).toBe('invalid');
    expect(result.config.agents).toEqual(defaultConfig.agents);
    expect(result.warnings.some((w) => w.includes('agents'))).toBe(true);
  });

  it('marks executables section invalid when globs is not an array', async () => {
    const yaml = 'executables:\n  globs: not-an-array\n';
    const fs = createMemFs({ [CONFIG_PATH]: yaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.validity.executables).toBe('invalid');
    expect(result.config.executables).toEqual(defaultConfig.executables);
    expect(result.warnings.some((w) => w.includes('executables'))).toBe(true);
  });

  it('marks security section invalid when hookConsentPolicy is an unknown value', async () => {
    const yaml = 'security:\n  hookConsentPolicy: never-ask\n';
    const fs = createMemFs({ [CONFIG_PATH]: yaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.validity.security).toBe('invalid');
    expect(result.config.security).toEqual(defaultConfig.security);
    expect(result.warnings.some((w) => w.includes('security'))).toBe(true);
  });

  it('marks notifications section invalid when enabled is not a boolean', async () => {
    const yaml = 'notifications:\n  enabled: "yes"\n';
    const fs = createMemFs({ [CONFIG_PATH]: yaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.validity.notifications).toBe('invalid');
    expect(result.config.notifications).toEqual(defaultConfig.notifications);
    expect(result.warnings.some((w) => w.includes('notifications'))).toBe(true);
  });

  it('handles a top-level YAML array (non-object) by using defaults for all sections', async () => {
    const yaml = '- item1\n- item2\n';
    const fs = createMemFs({ [CONFIG_PATH]: yaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    // All sections fall back to defaults because raw is an array, not an object.
    expect(result.config).toEqual(defaultConfig);
    expect(Object.values(result.validity).every((v) => v === 'valid')).toBe(true);
  });

  it('defaults the repositories section to gitPath "git"', async () => {
    const fs = createMemFs({});
    const { config, validity } = await loadConfig(fs, '/does/not/exist.yaml');
    expect(config.repositories.gitPath).toBe('git');
    expect(validity.repositories).toBe('valid');
  });

  it('defaults theme to system', async () => {
    const fs = createMemFs({});
    const { config } = await loadConfig(fs, '/does/not/exist.yaml');
    expect(config.general.theme).toBe('system');
  });

  it('marks repositories section invalid when gitPath is not a string', async () => {
    const yaml = 'repositories:\n  gitPath: 123\n';
    const fs = createMemFs({ [CONFIG_PATH]: yaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.validity.repositories).toBe('invalid');
    expect(result.config.repositories).toEqual(defaultConfig.repositories);
    expect(result.warnings.some((w) => w.includes('repositories'))).toBe(true);
  });

  it('marks general section invalid when theme is an unknown value', async () => {
    const yaml = 'general:\n  theme: neon\n';
    const fs = createMemFs({ [CONFIG_PATH]: yaml });
    const result = await loadConfig(fs, CONFIG_PATH);

    expect(result.validity.general).toBe('invalid');
    expect(result.config.general).toEqual(defaultConfig.general);
    expect(result.warnings.some((w) => w.includes('general'))).toBe(true);
  });
});

describe('saveConfig', () => {
  it('writes valid YAML that can be read back', async () => {
    const fs = createMemFs({});
    await saveConfig(fs, CONFIG_PATH, defaultConfig);

    const result = await loadConfig(fs, CONFIG_PATH);
    expect(result.config).toEqual(defaultConfig);
    expect(Object.values(result.validity).every((v) => v === 'valid')).toBe(true);
  });

  it('uses atomic rename (writes to a temp file first)', async () => {
    const renames: Array<{ from: string; to: string }> = [];
    const baseFs = createMemFs({});
    const trackingFs = {
      ...baseFs,
      rename: async (from: string, to: string): Promise<void> => {
        renames.push({ from, to });
        return baseFs.rename(from, to);
      },
    };

    await saveConfig(trackingFs, CONFIG_PATH, defaultConfig);

    expect(renames.length).toBe(1);
    const [r] = renames;
    expect(r).toBeDefined();
    expect(r!.to).toBe(CONFIG_PATH);
    expect(r!.from).not.toBe(CONFIG_PATH);
  });
});
