/**
 * Electron main process entry point.
 *
 * Owns: filesystem access, config, state, IPC handlers.
 * The renderer process is sandboxed and communicates only through the preload
 * bridge via ipcMain.handle channels.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createNodeFs } from '@skillkeeper/core';
import { loadConfig } from '@skillkeeper/config';
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
      // but guard against unexpected I/O errors.
      const message = err instanceof Error ? err.message : String(err);
      const { defaultConfig } = await import('@skillkeeper/config');
      const sections = ['general', 'updates', 'agents', 'executables', 'security', 'notifications'] as const;
      return {
        config: defaultConfig,
        validity: Object.fromEntries(sections.map((s) => [s, 'invalid'])) as LoadConfigResult['validity'],
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
