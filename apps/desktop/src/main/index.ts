/**
 * Electron main process entry point.
 *
 * Owns: filesystem access, config, state, IPC handlers.
 * The renderer process is sandboxed and communicates only through the preload
 * bridge via ipcMain.handle channels.
 */
import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { createNodeFs, loadState, StateError } from '@skillkeeper/core';
import { loadConfig, saveConfig, defaultConfig, SECTIONS } from '@skillkeeper/config';
import type { LoadConfigResult, SkillKeeperConfig } from '@skillkeeper/config';
import { listEditors, openInEditor } from './editors.js';

// ESM main process: `__dirname` is not a global, so derive the module directory
// from `import.meta.dirname` (Node 20.11+). Using a distinct name avoids any
// conflict with bundler-injected `__dirname` shims.
const moduleDir = import.meta.dirname;

// ---------------------------------------------------------------------------
// App-data path resolution (mirrors packages/cli/src/paths.ts exactly)
// ---------------------------------------------------------------------------

function resolveAppDataDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData !== undefined && appData.trim() !== '') {
      return path.join(appData, 'skillkeeper');
    }
  } else {
    const xdg = process.env['XDG_CONFIG_HOME'];
    if (xdg !== undefined && xdg.trim() !== '') {
      return path.join(xdg, 'skillkeeper');
    }
  }
  return path.join(os.homedir(), '.config', 'skillkeeper');
}

function resolveConfigPath(): string {
  return path.join(resolveAppDataDir(), 'config.yaml');
}

function resolveStatePath(): string {
  return path.join(resolveAppDataDir(), 'state.json');
}

// ---------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------

/**
 * Production CSP. Scripts are restricted to same-origin (the security-critical
 * directive); inline styles are allowed because React and bundled CSS inject
 * them, and images/fonts allow data: URIs. No plugins, no base-uri hijacking,
 * no network origins.
 */
const PROD_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "object-src 'none'; base-uri 'none'";

/**
 * Relaxed dev CSP. The electron-vite dev server serves an inline bootstrap
 * script and drives HMR over a websocket, both of which the strict policy would
 * block. This variant is only used when ELECTRON_RENDERER_URL is set (dev).
 */
const DEV_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' ws: http: https:; " +
  "object-src 'none'; base-uri 'none'";

/**
 * Apply a Content-Security-Policy response header to every request in the
 * default session. Strict in production; relaxed in dev so Vite HMR works.
 */
function installCsp(): void {
  const isDev = process.env['ELECTRON_RENDERER_URL'] !== undefined;
  const policy = isDev ? DEV_CSP : PROD_CSP;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerHandlers(): void {
  const fs = createNodeFs();
  const configPath = resolveConfigPath();
  const statePath = resolveStatePath();

  /**
   * config:get -- load the config file and return it together with per-section
   * validity and any warnings. Never throws; errors are surfaced as warnings.
   */
  ipcMain.handle('config:get', async (): Promise<LoadConfigResult> => {
    try {
      return await loadConfig(fs, configPath);
    } catch (err) {
      // Defensive: should not happen because loadConfig handles missing files,
      // but guard against unexpected I/O errors. The validity map is built from
      // SECTIONS so it never drifts from the canonical section list.
      const message = err instanceof Error ? err.message : String(err);
      return {
        config: defaultConfig,
        validity: Object.fromEntries(
          SECTIONS.map((s) => [s, 'invalid']),
        ) as LoadConfigResult['validity'],
        warnings: [`Failed to load config: ${message}`],
      };
    }
  });

  /**
   * config:set -- persist the given config and return the reloaded result
   * (config, validity, warnings). Never throws; errors are surfaced as
   * warnings, mirroring the config:get fallback.
   */
  ipcMain.handle(
    'config:set',
    async (_event, config: SkillKeeperConfig): Promise<LoadConfigResult> => {
      try {
        await saveConfig(fs, configPath, config);
        return await loadConfig(fs, configPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          config: defaultConfig,
          validity: Object.fromEntries(
            SECTIONS.map((s) => [s, 'invalid']),
          ) as LoadConfigResult['validity'],
          warnings: [`Failed to save config: ${message}`],
        };
      }
    },
  );

  /**
   * editors:list -- detect installed editors (plus the OS default app) that
   * can open the config file. Never throws; failures surface as an empty
   * list so the renderer can fall back gracefully.
   */
  ipcMain.handle('editors:list', async () => {
    try {
      return await listEditors(configPath);
    } catch {
      return [];
    }
  });

  /**
   * config:openInEditor -- launch the given allowlisted editor id (or the OS
   * default app) on the config file.
   */
  ipcMain.handle('config:openInEditor', async (_event, editorId: string) => {
    return openInEditor(editorId, configPath);
  });

  /**
   * repositories:list -- read tracked repositories from the state file.
   * Returns empty array when the file is missing (emptyState) or corrupt
   * (StateError).
   */
  ipcMain.handle('repositories:list', async () => {
    try {
      return (await loadState(fs, statePath)).repositories;
    } catch (err) {
      if (err instanceof StateError) return [];
      throw err;
    }
  });

  /**
   * projects:list -- read tracked projects from the state file.
   * Returns empty array when the file is missing or corrupt.
   */
  ipcMain.handle('projects:list', async () => {
    try {
      return (await loadState(fs, statePath)).projects;
    } catch (err) {
      if (err instanceof StateError) return [];
      throw err;
    }
  });

  /**
   * skills:list -- read install manifests from the state file.
   * Returns empty array when the file is missing or corrupt.
   */
  ipcMain.handle('skills:list', async () => {
    try {
      return (await loadState(fs, statePath)).installs;
    } catch (err) {
      if (err instanceof StateError) return [];
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow(): void {
  const preloadPath = path.join(moduleDir, '../preload/index.cjs');

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  // In production: load the built renderer HTML.
  // In dev (electron-vite): the ELECTRON_RENDERER_URL env var is set.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl !== undefined) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(path.join(moduleDir, '../renderer/index.html'));
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

registerHandlers();

void app.whenReady().then(() => {
  installCsp();
  createWindow();

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked and no windows are open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Quit on all platforms except macOS (where apps conventionally stay active).
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
