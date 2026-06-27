/**
 * Resolve OS-specific application data paths for SkillKeeper.
 *
 * Uses XDG conventions on Linux/macOS and %APPDATA% on Windows, falling back
 * gracefully to ~/.config/skillkeeper when the standard env vars are absent.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Return the SkillKeeper application-data directory for the current OS.
 *
 * Precedence:
 *   Linux/macOS: $XDG_CONFIG_HOME/skillkeeper, or ~/.config/skillkeeper
 *   Windows:     %APPDATA%/skillkeeper, or ~/.config/skillkeeper
 */
export function appDataDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData !== undefined && appData.trim() !== '') {
      return join(appData, 'skillkeeper');
    }
  } else {
    const xdg = process.env['XDG_CONFIG_HOME'];
    if (xdg !== undefined && xdg.trim() !== '') {
      return join(xdg, 'skillkeeper');
    }
  }
  return join(homedir(), '.config', 'skillkeeper');
}

/** Absolute path to config.yaml inside the app-data dir. */
export function configPath(dataDir?: string): string {
  return join(dataDir ?? appDataDir(), 'config.yaml');
}

/** Absolute path to state.json inside the app-data dir. */
export function statePath(dataDir?: string): string {
  return join(dataDir ?? appDataDir(), 'state.json');
}
