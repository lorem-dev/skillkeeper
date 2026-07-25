# SkillKeeper Changelog

## Development

## Version 0.2.1-rc.1

### Added

- Skill-resolution warnings are surfaced instead of discarded, so a `SKILL.md`
  that cannot be installed no longer goes missing without explanation. The CLI
  prints them to stderr per repository; the desktop app logs them under a new
  `warning` level, shown by default alongside errors and deliberately without a
  toast. The bell badge counts warnings in orange, or errors in red -- errors
  only, whenever there are any -- and clamps to `9+`.
- Hindi (`hi`) and Thai (`th`), bringing the total to 18 languages. Hindi carries
  the `one`/`other` plural categories, Thai only `other`, per CLDR.
- `pnpm run i18n` takes an optional language list (`-- ru de`, or
  `--langs=ru,de`) instead of always regenerating all 18 catalogs.
- `examples/test-repo`: a submodule tracking the fixture repository that covers
  every skill/group/hook/MCP-preset resolution path.
- `pnpm test:e2e`: an end-to-end suite (Jest, in `e2e/`) that drives the built CLI
  against that fixture and asserts on the files it writes -- the layer the
  in-memory unit tests cannot reach. It runs in CI and via the new
  `check-fixture-repo` skill, which `pre-release-check` now includes.

### Fixed

- `skill repair` removes the `extraneous` files it used to leave behind, so a
  repaired install finally verifies clean, and reports each deleted path. The
  deletion is bounded: files recorded by another install sharing the destination
  directory are protected, and a recorded path that could resolve outside that
  directory disables pruning rather than being followed.
- Skill resolution skips hidden directories and dependency or build trees
  (`node_modules`, `vendor`, `target`, `dist`) entirely. Every agent keeps its
  *installed* skills under a hidden directory, so a repository that itself uses
  SkillKeeper warned about skills it consumes rather than publishes. An explicit
  `path` in `skillkeeper.repo.yaml` still reaches them.

### Changed

- `homepage` in all three workspace manifests points at the documentation site,
  alongside new `repository` and `bugs` entries.

## Version 0.2.0

### Added

- Desktop: a first-run tutorial (guided onboarding) - a welcome screen
  (language/theme) with preloader, guided steps that spotlight the
  Add-project/Add-repository buttons and illustrate the skills-management
  tree and per-project agent picker, a thank-you screen, "Start the tutorial
  again" in Settings and (macOS) the Help menu, ESC/Skip to end, with
  progress persisted to onboarding.json.

### Fixed

- Desktop: the embedded terminal keeps its colors in sync with the active
  theme -- previously it kept the theme it was created with, so switching
  theme left it inverted until restart.

## Version 0.1.2-rc.1

### Features

- `skill install` without `--agent` installs for every agent detected in the
  project directory (by marker files, the same detection the desktop app uses);
  pass `--agent` to target a single one.
- Accept a unique skill-id prefix wherever a skill id is taken
  (install/info/uninstall/update/verify/repair), Docker-container-id style: a
  prefix that matches exactly one skill resolves to it; an ambiguous prefix is
  rejected with the candidates.
- `repo add` now makes the local-path argument optional -- when omitted, the
  repository is cloned into a per-repository directory under the app's
  repositories folder (the same location the desktop app uses) -- and enables
  Git LFS by default when `git-lfs` is installed (override with `--no-lfs`).
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
