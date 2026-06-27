# Architecture

## Package graph

SkillKeeper is a pnpm monorepo of focused packages over one domain core. The
core is framework-agnostic and performs no direct console or Electron I/O.

```
@skillkeeper/core      (no internal deps)   domain model, resolver, hashing,
                                            install engine, hooks, verify/repair,
                                            git port, scheduler, adapter interface

@skillkeeper/config    -> core              YAML load/save, zod schema, sectioned
                                            validation with defaults

@skillkeeper/agents    -> core              adapter registry + Claude (reference)
                                            and Codex/Copilot/Cursor/OpenCode adapters

@skillkeeper/i18n      (no internal deps)   typed catalogs (en/de/ru) + lookup

@skillkeeper/cli       -> core, config,     commander-based CLI
                          agents, i18n

apps/desktop           -> core, config,     Electron main/preload/renderer
                          agents, i18n      (React + Zustand). Shell only in v1.
```

The dependency graph is acyclic. `@skillkeeper/core` defines the `AgentAdapter`
interface; `@skillkeeper/agents` implements it (dependency inversion), so the
install engine never imports a concrete agent adapter directly.

## Domain model

All types are defined in `@skillkeeper/core`.

- `SkillId` - stable identity: `{ group?: string, name: string }`.
- `SkillManifest` - parsed `SKILL.md` frontmatter: name, optional version,
  optional description, optional license, optional declared executables, and
  optional hook references.
- `HookManifest` - parsed `HOOK.md` frontmatter: name, the target it edits
  (agent + file pattern or config key path), and the apply strategy
  (`delimited-text`, `json-merge`, or `file`).
- `ResolvedSkill` - a skill discovered in a working tree: its `SkillId`, source
  paths, `SkillManifest`, file list, and resolved hooks.
- `Repository` - `{ id, name, url, kind, transport, lfs, localPath, lastFetched? }`.
- `AgentTarget` - `{ agent: AgentKind, scope: 'project' | 'global', projectId? }`.
- `InstallManifest` - one installed skill at one target. Records source, resolved
  `SkillId`, version, install time, `ManagedFile` entries, and `ManagedHookEdit`
  entries.
- `ManagedFile` - `{ relPath, sha256, executable: boolean }`.
- `ManagedHookEdit` - a tagged union:
  - `{ kind: 'delimited', file, delimiterId, sha256 }` for comment-delimited
    regions in text files.
  - `{ kind: 'json', file, keyPath, markerId, sha256 }` for entries merged into
    a JSON config (such as Claude `settings.json`).
  - `{ kind: 'file', ...ManagedFile }` for hook-owned standalone files.
- `Project` - a tracked directory: `{ id, path, name, addedAt }`.

## State storage

Two stores under the OS application-data directory, kept separate because they
have different lifecycles:

- `config.yaml` - user settings. User-editable. See [Configuration](configuration.md).
- Application state store (JSON) - repositories, tracked projects, and install
  manifests with hashes. Written only by SkillKeeper. Each write is atomic
  (write to a temp file, then rename). A schema version field allows forward
  migration.

## Desktop process boundaries

The desktop app has three processes with strict boundaries:

- **Main process** - owns the filesystem, Git, scheduler, config, and
  notifications. The only place the domain core runs in the GUI.
- **Preload** - exposes a narrow, typed `window.skillkeeper` bridge over IPC
  using `contextBridge`. `contextIsolation` is on, `nodeIntegration` is off,
  `sandbox` is on.
- **Renderer** - React UI; never touches Node APIs directly. All privileged work
  crosses IPC to the main process, which re-validates every request.

## Technology choices

| Concern          | Choice                | Rationale                                    |
|------------------|-----------------------|----------------------------------------------|
| Language         | TypeScript (strict)   | One language across all packages.            |
| Package manager  | pnpm workspaces       | Strict, fast, good monorepo isolation.       |
| UI framework     | React                 | Required.                                    |
| State store      | Zustand               | Small, modern, minimal boilerplate.          |
| Desktop runtime  | Electron              | Required; cross-platform desktop.            |
| Desktop build    | electron-vite         | One Vite pipeline for main/preload/renderer. |
| Packaging        | electron-builder      | dmg, AppImage/deb, nsis, and appx (MSIX).    |
| Lib build        | tsc project references| No extra bundler for libraries.              |
| Tests            | Vitest + v8 coverage  | Fast, Vite-native, coverage gate built in.   |
| Lint / format    | ESLint + Prettier     | Standard, enforced in CI.                    |
| Config parsing   | yaml                  | Round-trips comments; well maintained.       |
| Schema validation| zod                   | TS-first; types inferred from one schema.    |
| CLI parsing      | commander             | Small, standard, well documented.            |
| Git, SSH, LFS    | system git subprocess | Honors user ssh-agent, LFS, and git config.  |
| Hashing          | Node crypto (SHA-256) | Built in; no extra dependency.               |
| i18n             | custom catalogs       | Three languages; avoids a heavy dependency.  |
| Notifications    | Electron Notification | Built in for the GUI.                        |

Runtime dependencies are intentionally few: `yaml`, `zod`, `commander`,
`react`, `react-dom`, `zustand`. Every new direct dependency must pass the
license policy in `CONTRIBUTING.md` and be justified.

Git is invoked as a subprocess with argument arrays only (no shell string
interpolation). This reuses the user's existing SSH, ssh-agent, and Git LFS
setup, keeps credential handling out of the application, and reduces the
dependency and attack surface.

## Repository layout

```
skillkeeper/
  apps/
    desktop/            Electron main/preload/renderer (React + Zustand)
      build/            icons, Windows Store metadata, electron-builder config
  packages/
    core/               domain model, resolver, hashing, install engine, hooks,
                        verify/repair, git port, scheduler, adapter interface
    config/             YAML + zod sectioned validation
    agents/             adapter registry + Claude/Codex/Copilot/Cursor/OpenCode
    cli/                commander CLI
    i18n/               en/de/ru catalogs + lookup
  docs/                 mkdocs site (this site)
  .github/workflows/    CI: lint, typecheck, test+coverage, build, release
  AGENTS.md  CLAUDE.md  CONTRIBUTING.md  README.md  CHANGES.md  LICENSE
  package.json  pnpm-workspace.yaml  tsconfig.base.json
```
