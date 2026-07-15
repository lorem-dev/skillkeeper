/**
 * Electron main process entry point.
 *
 * Owns: filesystem access, config, state, IPC handlers.
 * The renderer process is sandboxed and communicates only through the preload
 * bridge via ipcMain.handle channels.
 */
import { app, BrowserWindow, ipcMain, session, dialog, nativeImage, nativeTheme } from 'electron';
import path from 'node:path';
import os from 'node:os';
// The padded app icons (generate-icons.mjs), bundled into the build output.
// electron-builder only applies icons to packaged apps, so the dock/taskbar
// shows the default Electron icon in `dev` unless we set it at runtime here.
// Two appearances are bundled and swapped to follow the OS theme.
import appIconLightAsset from '../../build/icon.app.png?asset';
import appIconDarkAsset from '../../build/icon-dark.app.png?asset';
import { createNodeFs, loadState, StateError, createSystemGit } from '@skillkeeper/core';
import type { HostEnv } from '@skillkeeper/core';
import { loadConfig, saveConfig, defaultConfig, SECTIONS } from '@skillkeeper/config';
import type { LoadConfigResult, SkillKeeperConfig } from '@skillkeeper/config';
import { listEditors, openInEditor } from './editors.js';
import { createConfigWatcher } from './configWatcher.js';
import type { ConfigWatcher } from './configWatcher.js';
import { ensureSshAgent, stopSshAgent } from './sshAgent.js';
import { getTerminal } from './terminal.js';
import { primeMacDiskAccess } from './diskAccess.js';
import {
  addRepository,
  cloneRepository,
  updateRepository,
  removeRepository,
  syncRepository,
  hasRepoUpdate,
  describeRepository,
  listBranches,
  listAvailableSkills,
} from './repositories.js';
import type { RepoDeps } from './repositories.js';
import { addProject, updateProject, removeProject, describeProject, projectExists } from './projects.js';
import type { ProjectDeps } from './projects.js';
import {
  detectProjectAgents,
  applySkillChanges,
  reconcileProjectSkills,
  createAdapterRegistry,
} from './skills.js';
import type { SkillsDeps, ApplyArgs } from './skills.js';
import {
  listAvailableMcp,
  applyMcp,
  listMcpInstalls,
  reconcileMcp,
  updateMcp,
  mcpUpdatePreflight,
} from './mcp.js';
import type { ApplyMcpArgs, UpdateMcpArgs, McpUpdatePreflightArgs } from './mcp.js';

// ESM main process: `__dirname` is not a global, so derive the module directory
// from `import.meta.dirname` (Node 20.11+). Using a distinct name avoids any
// conflict with bundler-injected `__dirname` shims.
const moduleDir = import.meta.dirname;

let configWatcher: ConfigWatcher | undefined;

/**
 * Push a reloaded config result to the renderer, e.g. after an external edit
 * of the config file is detected by the watcher.
 */
function broadcastConfig(result: LoadConfigResult): void {
  rememberGitPath(result.config);
  rememberTheme(result.config);
  const [win] = BrowserWindow.getAllWindows();
  win?.webContents.send('config:changed', result);
}

/**
 * Latest git executable path from config. The git port reads this via a resolver
 * (evaluated per command) so editing the path in Settings takes effect without a
 * restart. Defaults to "git" (resolved via PATH); seeded at startup and refreshed
 * on every config load/save/watch.
 */
let gitPath = 'git';

/** Remember the configured git executable path for subsequent git commands. */
function rememberGitPath(config: SkillKeeperConfig): void {
  gitPath = config.repositories.gitPath;
}

/**
 * Drive the OS-level theme source from the app's theme preference so the
 * dock/taskbar icon (and native chrome) follow the same setting the renderer
 * uses -- `config.general.theme` is 'system' | 'light' | 'dark', matching
 * nativeTheme.themeSource exactly. Then refresh the icon. `shouldUseDarkColors`
 * (read by themedAppIcon) reflects this, so a 'dark'/'light' preference picks
 * the right icon and 'system' tracks the OS. Called on every config
 * load/save/watch so an in-app theme switch updates the icon immediately.
 */
function rememberTheme(config: SkillKeeperConfig): void {
  nativeTheme.themeSource = config.general.theme;
  applyAppIcon();
}

/**
 * GUI apps launched outside a login shell (Finder/dock on macOS) inherit a
 * minimal PATH that often omits Homebrew/local bin dirs, so `git` (and
 * git-lfs/ssh) may not be found -- the "spawn git ENOENT" failure. Append the
 * common locations to process.env.PATH IN PLACE (same object, so the ssh-agent's
 * later SSH_AUTH_SOCK injection stays visible to git). No-op on Windows, where
 * git installers put themselves on PATH.
 */
function ensureToolPathDirs(): void {
  if (process.platform === 'win32') return;
  const parts = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  process.env['PATH'] = parts.join(':');
}

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
 * block. This variant is only used when ELECTRON_RENDERER_URL is set (dev). It
 * keeps prod's data: allowance for images/fonts -- without an explicit img-src
 * these fall back to default-src 'self', which blocks the data: URLs used for
 * editor icons (app.getFileIcon -> toDataURL).
 */
const DEV_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
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
  // Widen PATH before anything spawns git/ssh so the default `git` resolves.
  ensureToolPathDirs();

  const fs = createNodeFs();
  const configPath = resolveConfigPath();
  const statePath = resolveStatePath();
  configWatcher = createConfigWatcher(fs, configPath, broadcastConfig);

  const hostEnv: HostEnv = {
    homeDir: os.homedir(),
    platform: process.platform,
    // The same process.env object (by reference), so the ssh-agent's later
    // SSH_AUTH_SOCK injection is visible to git subprocesses.
    env: process.env as Record<string, string | undefined>,
  };
  const repoDeps: RepoDeps = {
    fs,
    // Resolver (not a fixed string) so a Settings change to the git path applies
    // to the next command without rebuilding the port or restarting.
    git: createSystemGit(hostEnv, undefined, () => gitPath),
    statePath,
    reposDir: path.join(resolveAppDataDir(), 'repositories'),
    // Runs clone/sync IN the terminal PTY: git executes with an argument array
    // (no shell -- no injection), its output streams to the terminal, and an ssh
    // passphrase prompt reads the terminal's input. Non-zero exit -> error.
    terminalGit: createSystemGit(hostEnv, {
      run: async (args: readonly string[], cwd: string) => {
        const code = await getTerminal().runGit(gitPath, args, cwd);
        if (code !== 0) throw new Error(`git ${args[0] ?? ''} exited with code ${String(code)}`);
        return { stdout: '', stderr: '' };
      },
    }),
  };

  const skillsDeps: SkillsDeps = {
    fs,
    statePath,
    configPath,
    registry: createAdapterRegistry(),
    adapterEnv: { ...hostEnv, fs },
  };

  /**
   * config:get -- load the config file and return it together with per-section
   * validity and any warnings. Never throws; errors are surfaced as warnings.
   */
  ipcMain.handle('config:get', async (): Promise<LoadConfigResult> => {
    try {
      const result = await loadConfig(fs, configPath);
      rememberGitPath(result.config);
      rememberTheme(result.config);
      return result;
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
        const result = await loadConfig(fs, configPath);
        rememberGitPath(result.config);
        rememberTheme(result.config);
        await configWatcher?.noteWritten();
        return result;
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

  const projectDeps: ProjectDeps = { fs, statePath };
  // Native folder picker for adding/editing a project; null when cancelled.
  ipcMain.handle('dialog:selectFolder', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
  });
  ipcMain.handle('projects:add', (_e, args: { path: string; name: string }) => addProject(projectDeps, args));
  ipcMain.handle('projects:update', (_e, args: { id: string; path: string; name: string }) =>
    updateProject(projectDeps, args),
  );
  ipcMain.handle('projects:remove', (_e, args: { id: string }) => removeProject(projectDeps, args));
  ipcMain.handle('projects:describe', (_e, args: { id: string }) => describeProject(projectDeps, args));
  ipcMain.handle('projects:exists', (_e, args: { id: string }) => projectExists(projectDeps, args));
  // Open the project folder in the given editor id, or the OS file manager
  // (DEFAULT_EDITOR_ID / shell.openPath) -- the default for a folder.
  ipcMain.handle('projects:open', (_e, args: { path: string; editorId: string }) =>
    // Always open a project in a NEW editor window (never reuse the current one).
    openInEditor(args.editorId, args.path, true),
  );

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

  ipcMain.handle('repositories:add', (_e, args: { url: string; name: string }) => addRepository(repoDeps, args));
  ipcMain.handle('repositories:clone', (_e, args: { id: string }) => cloneRepository(repoDeps, args));
  ipcMain.handle('repositories:update', (_e, args: { id: string; name: string; url: string; branch?: string }) =>
    updateRepository(repoDeps, args),
  );
  ipcMain.handle('repositories:listBranches', (_e, args: { id: string }) => listBranches(repoDeps, args));
  ipcMain.handle('repositories:remove', (_e, args: { id: string }) => removeRepository(repoDeps, args));
  ipcMain.handle('repositories:sync', (_e, args: { id: string }) => syncRepository(repoDeps, args));
  ipcMain.handle('repositories:hasUpdate', (_e, args: { id: string }) => hasRepoUpdate(repoDeps, args));
  ipcMain.handle('repositories:describe', (_e, args: { id: string }) => describeRepository(repoDeps, args));
  // skills:available -- every skill resolved across all cloned repositories.
  ipcMain.handle('skills:available', () => listAvailableSkills(repoDeps));
  // projects:detectAgents -- which agents were used in a project folder.
  ipcMain.handle('projects:detectAgents', (_e, args: { path: string }) =>
    detectProjectAgents(fs, args.path),
  );
  // skills:apply -- install/remove skills for a project, streaming progress.
  ipcMain.handle('skills:apply', (event, args: ApplyArgs) =>
    applySkillChanges(skillsDeps, args, (p) => event.sender.send('skills:progress', p)),
  );
  // skills:reconcile -- scan project folders, adopt/prune installs; returns the
  // reconciled manifest list.
  ipcMain.handle('skills:reconcile', () => reconcileProjectSkills(skillsDeps));

  // mcp:list-available -- every MCP server preset resolved across all repos.
  ipcMain.handle('mcp:list-available', () => listAvailableMcp(repoDeps));
  // mcp:apply -- install/remove MCP server instances for a project across agents.
  ipcMain.handle('mcp:apply', (_e, args: ApplyMcpArgs) => applyMcp(skillsDeps, args));
  // mcp:installs -- read every agent ledger; no pruning.
  ipcMain.handle('mcp:installs', () => listMcpInstalls(skillsDeps));
  // mcp:reconcile -- prune ledger/params entries whose native server is gone;
  // returns the surviving install list.
  ipcMain.handle('mcp:reconcile', () => reconcileMcp(skillsDeps));
  // mcp:update -- remove + reinstall instances under the same name with a new def.
  ipcMain.handle('mcp:update', (_e, args: UpdateMcpArgs) => updateMcp(skillsDeps, args));
  // mcp:update-preflight -- which params the new def needs that the instance's
  // own stored params are missing, ahead of an update.
  ipcMain.handle('mcp:update-preflight', (_e, args: McpUpdatePreflightArgs) =>
    mcpUpdatePreflight(skillsDeps, args),
  );

  const terminal = getTerminal();
  terminal.on('data', (chunk: string) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('terminal:data', chunk);
  });
  terminal.on('exit', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('terminal:exit');
  });
  // A background git command asked for input (ssh passphrase, etc.) -> surface
  // the terminal so the user can answer. Commands that need no input stay hidden.
  terminal.on('needsInput', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('terminal:requestOpen');
  });
  ipcMain.handle('terminal:start', (_e, { cols, rows }: { cols: number; rows: number }) =>
    terminal.start(cols, rows),
  );
  ipcMain.on('terminal:input', (_e, data: string) => terminal.write(data));
  ipcMain.on('terminal:clearBuffer', () => terminal.clearBuffer());
  ipcMain.on('terminal:resize', (_e, { cols, rows }: { cols: number; rows: number }) =>
    terminal.resize(cols, rows),
  );
  ipcMain.handle('terminal:runSshAdd', () => {
    terminal.runSshAdd();
  });

  // Window controls for the frameless title bar. Driven by the renderer's
  // custom controls (Windows/Linux); each acts on the window that sent it.
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window:toggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w === null) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle(
    'window:isMaximized',
    (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
  );
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

/** The app icon for the current OS theme (dark appearance -> dark variant). */
function themedAppIcon(): Electron.NativeImage {
  const asset = nativeTheme.shouldUseDarkColors ? appIconDarkAsset : appIconLightAsset;
  return nativeImage.createFromPath(asset);
}

/**
 * Window background for the current theme. Matches the index.html preloader and
 * --sk-color-bg-secondary, so the window shows its themed colour rather than the
 * default white before the renderer's first paint.
 */
function themedWindowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7';
}

/**
 * Apply the theme-appropriate icon. macOS ignores BrowserWindow.icon, so the
 * dock icon is set on the app; Windows/Linux set it per window. Called on
 * window creation and whenever the OS theme changes.
 */
function applyAppIcon(): void {
  const icon = themedAppIcon();
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon);
  } else {
    for (const w of BrowserWindow.getAllWindows()) w.setIcon(icon);
  }
}

function createWindow(): void {
  const preloadPath = path.join(moduleDir, '../preload/index.cjs');
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    // Created hidden with a themed background and revealed on `ready-to-show`
    // (the renderer's first paint, i.e. the themed preloader), so the window
    // never flashes the default white before content is drawn.
    show: false,
    backgroundColor: themedWindowBackground(),
    // Frameless. On macOS there is no custom bar: the app content reaches the
    // top and the native traffic lights (kept via the hidden title-bar style)
    // float over the sidebar's top-left, which reserves top padding for them
    // (see App.scss `.sk-app--mac .sk-sidebar`); the draggable region is set on
    // the top of the sidebar and page header there. On Windows/Linux there are
    // no native overlay controls, so go fully frameless and the renderer draws
    // its own window controls in a top strip (TitleBar).
    // macOS ignores BrowserWindow.icon (the dock icon is set via app.dock in
    // applyAppIcon); Windows/Linux take the themed icon here.
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 13 } }
      : { frame: false, icon: themedAppIcon() }),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Tell the renderer when the window's maximized state changes, so the custom
  // maximize/restore control (Windows/Linux) can swap its glyph.
  const sendMaximized = (value: boolean): void => win.webContents.send('window:maximizeChanged', value);
  win.on('maximize', () => sendMaximized(true));
  win.on('unmaximize', () => sendMaximized(false));

  // In production: load the built renderer HTML.
  // In dev (electron-vite): the ELECTRON_RENDERER_URL env var is set.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl !== undefined) {
    void win.loadURL(rendererUrl);
    // In dev, open the DevTools in their own detached window.
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(moduleDir, '../renderer/index.html'));
  }

  configWatcher?.start();
  win.on('closed', () => configWatcher?.stop());
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

registerHandlers();

void app.whenReady().then(async () => {
  // Set the dock/taskbar icon to the theme-appropriate variant from the very
  // first frame -- before any async init below can delay it -- and keep it in
  // sync when the OS appearance (or, via themeSource, the app preference)
  // changes.
  nativeTheme.on('updated', applyAppIcon);
  applyAppIcon();
  // Seed the git path and theme from config before the first git command may
  // run and before the window appears, so the persisted theme preference wins
  // over the bare OS default immediately.
  try {
    const { config } = await loadConfig(createNodeFs(), resolveConfigPath());
    rememberGitPath(config);
    rememberTheme(config);
  } catch {
    // Keep the "git" default; config:get will refresh it once the renderer loads.
  }
  await ensureSshAgent();
  // Start the terminal session now (after the ssh-agent env is set, so the shell
  // inherits SSH_AUTH_SOCK) so it is initialized before any task runs; runGit
  // waits for the shell to be ready before typing a command.
  getTerminal().start(80, 24);
  installCsp();
  createWindow();
  // macOS: surface the disk-access prompt early so project folders in protected
  // locations are readable when needed. No-op elsewhere; never blocks startup.
  void primeMacDiskAccess();

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked and no windows are open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  stopSshAgent();
  getTerminal().dispose();
});

app.on('window-all-closed', () => {
  // Quit on all platforms except macOS (where apps conventionally stay active).
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
