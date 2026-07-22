# SkillKeeper Changelog

## Development

### Features

- Publish the standalone `skillkeeper` CLI as a per-platform archive
  (`skillkeeper-cli-<target>.tar.gz`/`.zip`) with each release, and add one-line
  install scripts (`scripts/install.sh`, `scripts/install.ps1`) that detect the
  platform, download the binary, and put it on the PATH.

## Version 0.1.1

### Features

- Add a `skillkeeper version` CLI subcommand, and accept `-v` as an alias for the
  existing `-V` / `--version` flags, all printing `skillkeeper <version>`.
- Make the native folder picker for adding a project window-modal (parented to
  the main window) so the app window cannot be used while it is open, and closes
  with it.

### Fixes

- Fall back to the name-keyed colour gradient on project cards that have an icon
  where blur is not painted (software compositing), matching the cards without
  an icon.
- Focus and raise the main window once the app finishes launching, so it is not
  left unfocused behind other windows when the launch completes in the
  background.
- Localize the title-bar window controls, the About copyright line, the MCP
  "no matching project" empty state, and the hook-consent notice across the
  supported languages, and translate the macOS application menu title.
- Restore the Page toolbar shading wash on Windows/Linux as a gradient from the
  standard page background color to transparent (instead of the dropped macOS
  theme tint).

## Version 0.1.1-rc.2

### Fixes

- Make the frosted surfaces more opaque on Windows/Linux so they stay legible
  when backdrop-filter blur is not painted (e.g. under software compositing),
  independent of the runtime software-renderer detection.
- Keep the title-bar app icon unselectable and let dragging it move the window.

## Version 0.1.1-rc.1

### Features

- Show a theme-aware app icon in the Windows/Linux title bar.

### Fixes

- Keep frosted surfaces legible where the engine parses but does not paint
  backdrop-filter (Windows under software compositing): fall back to solid
  backgrounds for headers, menus, popovers, and dialogs.
- Stop console windows from flashing when the app runs Git and other helper
  processes on Windows.

## Version 0.1.0

### Features

- Add the domain core: skill resolution (flat, grouped, and repo-config schemes),
  SHA-256 hashing, hook management (delimited-text and JSON-merge strategies),
  install, uninstall, verify, and repair, the agent adapter framework, the system
  git port, the application state store, and the update scheduler.
- Add agent adapters for Claude (skills and hooks), Codex, Copilot, Cursor, and
  OpenCode.
- Add the CLI with repo, skill, project, config, and check commands.
- Add the desktop shell with a sandboxed, typed IPC bridge.
- Build the desktop screens (Repositories, Projects, Skills, Settings) on the
  shared UI kit with real read-only data via a renderer services layer, entity
  cards, a skills search/filter and details view, and a light/dark theme toggle.
- Rebuild the desktop Settings screen on the Form kit and persist changes to the
  config file: live language switch, theme (system/light/dark) via a segmented
  control, and the git executable path, with a new config write path and a
  repositories config section.
- Watch the config file (polled once per second) and live-reload it in the app
  when it changes on disk, so external edits are reflected without a restart.
- Add a control on the Settings screen to open the config file in an editor: a
  split button listing detected editors with their system icons (macOS/Windows),
  a default-app fallback, and the selected editor remembered locally.
- Add a native macOS application menu (SkillKeeper, Edit, View, MCP, Settings,
  Window, Help) that mirrors the sidebar navigation, shows glyph icons, localizes
  its items in every supported language, adds a custom About dialog, and binds a
  Cmd+, (Ctrl+, elsewhere) shortcut matched by physical key so it works under
  non-Latin layouts. The menu is disabled on Windows and Linux.
- Add per-section YAML configuration with validation and default fallback.
- Add localization for English, German, and Russian.
- Add Storybook to the desktop app with stories for the shared UI kit
  (Button, Badge, Alert, Toggle, TextField, Select, Slider, Modal) and a
  light/dark theme toggle.
- Scaffold the pnpm and TypeScript monorepo with shared ESLint, Prettier, and a
  90% Vitest coverage gate.
- Add the mkdocs documentation site.
- Add five local development skills: changelog, docs, tests and linters, licenses,
  and pre-release checks.
- Add continuous integration and release workflows, including a Microsoft Store
  MSIX build for Windows.
- Publish releases with a signed checksum file: the release workflow attaches a
  SHA-256 `checksums.txt` and a detached GPG signature (`checksums.txt.asc`)
  verifiable against the public key committed at `.github/release-key.asc`.

### Fixes

- Make the desktop app launch reliably: resolve the main-process entry paths
  correctly and allow inline styles in the production CSP.
- Fix Windows rendering: correct WebView2 rendering and app-title placement, and
  the page chrome and glass borders on Windows and Linux.
- Remove the startup flash, open with a smaller initial window, and add sidebar
  top padding.
- Show notifications above overlays and make alerts more opaque.
- Generate the localization catalogs before `dev`/`build` so a fresh or cleaned
  checkout no longer fails to build with missing i18n catalog modules.
- Restrict macOS packaging to arm64; the x64 target is not supported in CI.
- Attribute the bundled Inter and Cormorant Garamond fonts (OFL-1.1) in LICENSE.
