# SkillKeeper Changelog

## Development

### Features

- Add a native macOS application menu (Skillkeeper, Edit, View, MCP, Settings,
  Window, Help) that mirrors the sidebar navigation, opens the native About
  panel with the app icon, and localizes its app-specific items in every
  supported language. Add a Cmd+, (Ctrl+, on other platforms) shortcut that
  opens Settings on all platforms, matched by physical key so it works under
  non-Latin keyboard layouts. The menu is disabled on Windows and Linux.
- Refine the macOS application menu: move MCP under View, localize the Edit,
  Window, Help and app-menu items in every supported language, show glyph icons
  on the menu items, and replace the native About panel with a custom About
  dialog that shows the SkillKeeper icon, version, and tagline.

## Version 0.1.0-rc.1 - 2026-07-17

### Features

- Watch the config file (polled once per second) and live-reload it in the app
  when it changes on disk, so external edits are reflected without a restart.
- Add a control on the Settings screen to open the config file in an editor: a
  split button listing detected editors with their system icons (macOS/Windows),
  a default-app fallback, and the selected editor remembered locally.
- Build the desktop screens (Repositories, Projects, Skills, Settings) on the
  shared UI kit with real read-only data via a renderer services layer, entity
  cards, a skills search/filter and details view, and a light/dark theme toggle.
- Rebuild the desktop Settings screen on the Form kit and persist changes to the
  config file: live language switch, theme (system/light/dark) via a segmented
  control, and the git executable path, with a new config write path and a
  repositories config section.
- Add Storybook to the desktop app with stories for the shared UI kit
  (Button, Badge, Alert, Toggle, TextField, Select, Slider, Modal) and a
  light/dark theme toggle.
- Scaffold the pnpm and TypeScript monorepo with shared ESLint, Prettier, and a
  90% Vitest coverage gate.
- Add the domain core: skill resolution (flat, grouped, and repo-config schemes),
  SHA-256 hashing, hook management (delimited-text and JSON-merge strategies),
  install, uninstall, verify, and repair, the agent adapter framework, the system
  git port, the application state store, and the update scheduler.
- Add per-section YAML configuration with validation and default fallback.
- Add localization for English, German, and Russian.
- Add agent adapters for Claude (skills and hooks), Codex, Copilot, Cursor, and
  OpenCode.
- Add the CLI with repo, skill, project, config, and check commands.
- Add the Electron desktop shell with a sandboxed, typed IPC bridge.
- Add the mkdocs documentation site.
- Add five local development skills: changelog, docs, tests and linters, licenses,
  and pre-release checks.
- Add continuous integration and release workflows, including a Microsoft Store
  MSIX build for Windows.

### Fixes

- Make the desktop app launch reliably: auto-download the Electron binary, use
  `import.meta.dirname` in the ESM main process, load the preload as CommonJS
  with `electron` kept external, and allow inline styles in the production CSP.
- Restrict macOS packaging to arm64; the x64 target is not supported in CI.
- Attribute the bundled Inter and Cormorant Garamond fonts (OFL-1.1) in LICENSE.
