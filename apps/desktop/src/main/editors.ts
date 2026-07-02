/**
 * Editor detection and launch for the "open config in an editor" control.
 *
 * Editors are launched from a fixed allowlist via spawn with argument arrays
 * (never a shell string); the only path passed is the caller-provided config
 * path. Icons are extracted from installed apps via app.getFileIcon on macOS and
 * Windows only (Linux returns no icon).
 */
import { app, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export interface EditorOption {
  readonly id: string;
  readonly name: string;
  readonly iconDataUrl?: string;
  readonly available: boolean;
}

export interface OpenResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** The synthetic id that opens the file in the OS default application. */
export const DEFAULT_EDITOR_ID = 'default';

interface EditorSpec {
  readonly id: string;
  readonly name: string;
  /** CLI command probed on PATH (all OSes). */
  readonly cli?: string;
  /** macOS app bundle name under /Applications or ~/Applications. */
  readonly macApp?: string;
  /** Windows executable basenames probed on PATH / PATHEXT. */
  readonly winExe?: string;
}

/** Fixed allowlist. Order is the display order. */
const EDITORS: readonly EditorSpec[] = [
  { id: 'vscode', name: 'Visual Studio Code', cli: 'code', macApp: 'Visual Studio Code.app', winExe: 'code' },
  { id: 'cursor', name: 'Cursor', cli: 'cursor', macApp: 'Cursor.app', winExe: 'cursor' },
  { id: 'zed', name: 'Zed', cli: 'zed', macApp: 'Zed.app' },
  { id: 'sublime', name: 'Sublime Text', cli: 'subl', macApp: 'Sublime Text.app', winExe: 'subl' },
  { id: 'textedit', name: 'TextEdit', macApp: 'TextEdit.app' },
  { id: 'notepad', name: 'Notepad', winExe: 'notepad' },
];

function whichCli(cli: string): string | undefined {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, [cli], { encoding: 'utf8' });
    if (r.status === 0) {
      const first = r.stdout.split(/\r?\n/).find((l) => l.trim() !== '');
      return first?.trim();
    }
  } catch {
    // ignore
  }
  return undefined;
}

function macAppPath(appName: string): string | undefined {
  const candidates = [path.join('/Applications', appName), path.join(os.homedir(), 'Applications', appName)];
  return candidates.find((p) => fs.existsSync(p));
}

/** Resolve a launchable spec to { cliPath?, appPath? } when available. */
function resolveEditor(spec: EditorSpec): { cliPath?: string; appPath?: string } | undefined {
  if (process.platform === 'darwin' && spec.macApp !== undefined) {
    const appPath = macAppPath(spec.macApp);
    if (appPath !== undefined) return { appPath, ...(spec.cli ? { cliPath: whichCli(spec.cli) } : {}) };
  }
  if (spec.cli !== undefined) {
    const cliPath = whichCli(spec.cli);
    if (cliPath !== undefined) return { cliPath };
  }
  if (process.platform === 'win32' && spec.winExe !== undefined) {
    const cliPath = whichCli(spec.winExe);
    if (cliPath !== undefined) return { cliPath };
  }
  return undefined;
}

async function iconFor(targetPath: string): Promise<string | undefined> {
  if (process.platform === 'linux') return undefined;
  try {
    const img = await app.getFileIcon(targetPath, { size: 'normal' });
    if (img.isEmpty()) return undefined;
    return img.toDataURL();
  } catch {
    return undefined;
  }
}

/** Build the list of available editors plus the default-app entry. */
export async function listEditors(configPath: string): Promise<EditorOption[]> {
  const out: EditorOption[] = [];
  for (const spec of EDITORS) {
    const resolved = resolveEditor(spec);
    if (resolved === undefined) continue;
    const iconTarget = resolved.appPath ?? resolved.cliPath;
    const iconDataUrl = iconTarget !== undefined ? await iconFor(iconTarget) : undefined;
    out.push({ id: spec.id, name: spec.name, available: true, ...(iconDataUrl ? { iconDataUrl } : {}) });
  }
  const defaultIcon = await iconFor(configPath);
  out.push({
    id: DEFAULT_EDITOR_ID,
    name: DEFAULT_EDITOR_ID,
    available: true,
    ...(defaultIcon ? { iconDataUrl: defaultIcon } : {}),
  });
  return out;
}

/** Open configPath in the given allowlisted editor id (or the default app). */
export async function openInEditor(editorId: string, configPath: string): Promise<OpenResult> {
  try {
    if (editorId === DEFAULT_EDITOR_ID) {
      const err = await shell.openPath(configPath);
      return err === '' ? { ok: true } : { ok: false, error: err };
    }
    const spec = EDITORS.find((e) => e.id === editorId);
    if (spec === undefined) return { ok: false, error: `Unknown editor: ${editorId}` };
    const resolved = resolveEditor(spec);
    if (resolved === undefined) return { ok: false, error: `Editor not available: ${editorId}` };
    if (resolved.cliPath !== undefined) {
      spawn(resolved.cliPath, [configPath], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    if (resolved.appPath !== undefined) {
      spawn('open', ['-a', resolved.appPath, configPath], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    return { ok: false, error: `Editor not launchable: ${editorId}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
