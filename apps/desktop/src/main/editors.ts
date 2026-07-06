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
  /** CLI flag that forces opening the target in a NEW window, when supported. */
  readonly newWindowArg?: string;
}

/** Fixed allowlist. Order is the display order. */
const EDITORS: readonly EditorSpec[] = [
  { id: 'vscode', name: 'Visual Studio Code', cli: 'code', macApp: 'Visual Studio Code.app', winExe: 'code', newWindowArg: '-n' },
  { id: 'cursor', name: 'Cursor', cli: 'cursor', macApp: 'Cursor.app', winExe: 'cursor', newWindowArg: '-n' },
  { id: 'zed', name: 'Zed', cli: 'zed', macApp: 'Zed.app' },
  { id: 'sublime', name: 'Sublime Text', cli: 'subl', macApp: 'Sublime Text.app', winExe: 'subl', newWindowArg: '-n' },
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

/**
 * Derive an `.app` bundle from a CLI path by resolving symlinks and taking the
 * enclosing bundle. Many editor CLIs (e.g. VS Code's `code`) are symlinks into
 * `.../Foo.app/Contents/...`, so this recovers the real app -- and thus a crisp
 * icon -- when the app is not in a standard /Applications location.
 */
function macAppFromCli(cliPath: string): string | undefined {
  try {
    const real = fs.realpathSync(cliPath);
    const marker = real.indexOf('.app/');
    if (marker !== -1) return real.slice(0, marker + '.app'.length);
  } catch {
    // Ignore: fall back to the CLI path for the icon.
  }
  return undefined;
}

/** Resolve a launchable spec to { cliPath?, appPath? } when available. */
function resolveEditor(spec: EditorSpec): { cliPath?: string; appPath?: string } | undefined {
  const cliPath = spec.cli !== undefined ? whichCli(spec.cli) : undefined;

  if (process.platform === 'darwin' && spec.macApp !== undefined) {
    // Prefer the real .app bundle so the icon is the app's, not a generic
    // executable glyph: a standard location first, then derived from the CLI
    // symlink when the app lives elsewhere.
    const appPath =
      macAppPath(spec.macApp) ?? (cliPath !== undefined ? macAppFromCli(cliPath) : undefined);
    if (appPath !== undefined) {
      return { appPath, ...(cliPath !== undefined ? { cliPath } : {}) };
    }
  }
  if (cliPath !== undefined) return { cliPath };
  if (process.platform === 'win32' && spec.winExe !== undefined) {
    const winPath = whichCli(spec.winExe);
    if (winPath !== undefined) return { cliPath: winPath };
  }
  return undefined;
}

/**
 * Extract a macOS `.app`'s real icon as a PNG data URL. `app.getFileIcon`
 * returns a generic bundle icon for apps, and nativeImage cannot read `.icns`,
 * so we resolve the bundle's icon file (CFBundleIconFile) and rasterize it with
 * the native `sips` tool. All spawns use argument arrays (no shell); the only
 * path passed is the allowlist-resolved bundle. Returns undefined on any miss so
 * the caller can fall back to getFileIcon.
 */
function macAppIconDataUrl(appPath: string): string | undefined {
  try {
    const info = spawnSync('defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleIconFile'], {
      encoding: 'utf8',
    });
    if (info.status !== 0) return undefined;
    let name = info.stdout.trim();
    if (name === '') return undefined;
    if (!name.endsWith('.icns')) name += '.icns';
    const icns = path.join(appPath, 'Contents', 'Resources', name);
    if (!fs.existsSync(icns)) return undefined;

    // Rasterize to 40px (crisp at the 20px display size on retina). sips writes
    // to a file, so use a pid+bundle-unique temp path and remove it after.
    const out = path.join(os.tmpdir(), `sk-editor-icon-${process.pid}-${path.basename(icns, '.icns')}.png`);
    const conv = spawnSync('sips', ['-s', 'format', 'png', '-z', '40', '40', icns, '--out', out], {
      encoding: 'utf8',
    });
    if (conv.status !== 0 || !fs.existsSync(out)) return undefined;
    const b64 = fs.readFileSync(out).toString('base64');
    fs.rmSync(out, { force: true });
    return `data:image/png;base64,${b64}`;
  } catch {
    return undefined;
  }
}

async function iconFor(targetPath: string): Promise<string | undefined> {
  if (process.platform === 'linux') return undefined;
  // macOS: app.getFileIcon returns a generic glyph for .app bundles, so pull the
  // real icon out of the bundle first; fall back to getFileIcon (correct for
  // plain files such as the config, and for non-bundle targets).
  if (process.platform === 'darwin' && targetPath.endsWith('.app')) {
    const fromBundle = macAppIconDataUrl(targetPath);
    if (fromBundle !== undefined) return fromBundle;
  }
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
export async function openInEditor(
  editorId: string,
  targetPath: string,
  newWindow = false,
): Promise<OpenResult> {
  try {
    if (editorId === DEFAULT_EDITOR_ID) {
      const err = await shell.openPath(targetPath);
      return err === '' ? { ok: true } : { ok: false, error: err };
    }
    const spec = EDITORS.find((e) => e.id === editorId);
    if (spec === undefined) return { ok: false, error: `Unknown editor: ${editorId}` };
    const resolved = resolveEditor(spec);
    if (resolved === undefined) return { ok: false, error: `Editor not available: ${editorId}` };
    // Force a new window when asked (opening a project) and the editor's CLI
    // supports it -- so it never reuses/replaces the user's current window.
    const nw = newWindow && spec.newWindowArg !== undefined ? [spec.newWindowArg] : [];
    if (resolved.cliPath !== undefined) {
      spawn(resolved.cliPath, [...nw, targetPath], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    if (resolved.appPath !== undefined) {
      // `open -n` launches a fresh instance (a new window) of the app.
      const openArgs = newWindow ? ['-n', '-a', resolved.appPath, targetPath] : ['-a', resolved.appPath, targetPath];
      spawn('open', openArgs, { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    return { ok: false, error: `Editor not launchable: ${editorId}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
