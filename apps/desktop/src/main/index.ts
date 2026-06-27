/**
 * Electron main process entry point.
 *
 * Owns: filesystem access, config, state, IPC handlers.
 * The renderer process is sandboxed and communicates only through the preload
 * bridge via ipcMain.handle channels.
 */
import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createNodeFs } from '@skillkeeper/core';
import { loadConfig, defaultConfig, SECTIONS } from '@skillkeeper/config';
import type { LoadConfigResult } from '@skillkeeper/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config path resolution (per-OS)
// ---------------------------------------------------------------------------

function resolveConfigPath(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'skillkeeper', 'config.yaml');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'skillkeeper', 'config.yaml');
  }
  // Linux / XDG
  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'skillkeeper', 'config.yaml');
}

// ---------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------

/**
 * Strict production CSP: only same-origin scripts/resources, no plugins, no
 * base-uri hijacking. The renderer loads a single external module script and
 * makes no network requests, so this is sufficient.
 */
const PROD_CSP = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'";

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
   * repositories:list -- stub; returns empty array until the state layer is
   * wired up in a subsequent task.
   */
  ipcMain.handle('repositories:list', async () => {
    return [];
  });

  /**
   * skills:list -- stub; returns empty array.
   */
  ipcMain.handle('skills:list', async () => {
    return [];
  });

  /**
   * projects:list -- stub; returns empty array.
   */
  ipcMain.handle('projects:list', async () => {
    return [];
  });
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow(): void {
  const preloadPath = path.join(__dirname, '../preload/index.js');

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
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
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
