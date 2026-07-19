# Architecture

## Package graph

SkillKeeper is a monorepo with two workspaces over one domain core: a Cargo
(Rust) workspace for the domain crates, the CLI, and the desktop backend, plus a
pnpm workspace for the desktop renderer and the one remaining TypeScript package
(`i18n`). The core is framework-agnostic and performs no direct console or
platform I/O.

Rust crates (Cargo workspace):

```
skillkeeper-core       (no internal deps)   domain model, resolver, SHA-256
                                            hashing, install/uninstall/verify/
                                            repair engine, hooks, git port,
                                            update scheduler, adapter interface,
                                            MCP model/install

skillkeeper-config     -> core              per-section config loading + serde
                                            validation with defaults

skillkeeper-agents     -> core              adapter registry + Claude (reference)
                                            and Codex/Copilot/Cursor/OpenCode adapters

skillkeeper-cli        -> core, config,     clap-based CLI (binary `skillkeeper`)
                          agents

apps/desktop/src-tauri -> core, config,     Tauri v2 backend (Rust): owns the
                          agents            filesystem, Git, config, application
                                            state, scheduler, and the PTY
```

TypeScript (pnpm workspace):

```
packages/i18n          (no internal deps)   typed catalogs (en source + de/ru) + lookup

apps/desktop           renderer             React 19 + Zustand renderer that talks
                                            to the Tauri backend
```

The dependency graph is acyclic. `skillkeeper-core` defines the agent adapter
interface; `skillkeeper-agents` implements it (dependency inversion), so the
install engine never depends on a concrete agent adapter directly.

## Domain model

All types are defined in the `skillkeeper-core` crate.

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

- `config.yaml` - user settings. User-editable. See [Configuration](../usage/configuration.md).
- Application state store (JSON) - repositories, tracked projects, and install
  manifests with hashes. Written only by SkillKeeper. Each write is atomic
  (write to a temp file, then rename). A schema version field allows forward
  migration.

## Desktop process boundaries

The desktop app splits into a Rust backend and a web renderer with strict
boundaries:

- **Tauri backend (Rust)** - `apps/desktop/src-tauri`. Owns the filesystem, Git,
  config, application state, the update scheduler, and the PTY. The only place
  the domain core runs in the GUI. It is the authority for all privileged data
  and re-validates every request.
- **Renderer** - React 19 + Zustand UI in `apps/desktop/src/renderer`. It holds
  UI state plus a mirror of backend data in a Zustand store and never touches
  the host directly. It reaches the backend only through
  `services/bridge/client.ts`, which calls Rust `#[tauri::command]` functions
  via Tauri `invoke()` and subscribes to backend events via `listen()`. This is
  a Tauri command/event bridge, not an OS-level notification hook.
- **Generated types** - renderer request/response shapes are generated from the
  Rust structs and enums via `ts-rs` (`#[ts(export)]`), emitted under
  `apps/desktop/src/renderer/services/bridge/generated/{core,config}/` when the
  crate tests run (`cargo test`). Rust is the single source of truth for those
  shapes.

## Technology choices

| Concern          | Choice                | Rationale                                    |
|------------------|-----------------------|----------------------------------------------|
| Core language    | Rust                  | Domain crates, CLI, and desktop backend.     |
| Renderer language| TypeScript (strict)   | React renderer and the `i18n` package.       |
| Cargo workspace  | Rust crates           | Core, config, agents, CLI, desktop backend.  |
| pnpm workspace   | renderer + `i18n`     | Strict, fast monorepo isolation for the TS side.|
| UI framework     | React 19              | Required.                                    |
| State store      | Zustand               | Small, modern, minimal boilerplate.          |
| Desktop runtime  | Tauri v2              | Rust backend + system webview; small bundles.|
| Renderer build   | Vite                  | Bundles the web renderer Tauri serves.       |
| Packaging        | Tauri bundler         | app, dmg, deb, appimage, nsis, msi.          |
| Renderer <-> backend| Tauri `invoke`/`listen`| Typed commands and events; Rust re-validates.|
| Generated types  | ts-rs                 | Renderer types derived from Rust structs.    |
| Tests            | cargo test; Vitest    | Rust unit tests; Vitest for the TS packages. |
| Lint / format    | rustfmt + clippy; ESLint + Prettier | Enforced in CI on both sides.   |
| Config parsing   | serde (YAML)          | Rust serde over the YAML config file.        |
| CLI parsing      | clap                  | Standard, well documented Rust CLI framework.|
| Git, SSH, LFS    | system git subprocess | Honors user ssh-agent, LFS, and git config.  |
| Hashing          | SHA-256 (`sha2`)      | Recorded per managed file and hook edit.     |
| i18n             | custom catalogs       | Three languages; avoids a heavy dependency.  |
| PTY terminal     | `portable-pty` (Rust) | Cross-platform terminal in the backend.      |

Runtime dependencies are intentionally few on both sides. Every new direct
dependency must pass the license policy in `CONTRIBUTING.md` and be justified.

Git is invoked as a subprocess with argument arrays only (no shell string
interpolation). This reuses the user's existing SSH, ssh-agent, and Git LFS
setup, keeps credential handling out of the application, and reduces the
dependency and attack surface.

## Repository layout

```
skillkeeper/
  apps/
    desktop/            Tauri v2 desktop app
      src/renderer/     React 19 + Zustand renderer
      src-tauri/        Tauri backend (Rust): filesystem, Git, config, state,
                        scheduler, PTY, Tauri commands/events
                        (icons/ is generated from assets/icons/, git-ignored)
  assets/
    icons/              app icon sources (icon-default.png / icon-dark.png)
  crates/
    skillkeeper-core/   domain model, resolver, hashing, install engine, hooks,
                        verify/repair, git port, scheduler, adapter interface, MCP
    skillkeeper-config/ per-section serde config loading + validation
    skillkeeper-agents/ adapter registry + Claude/Codex/Copilot/Cursor/OpenCode
    skillkeeper-cli/    clap CLI (binary `skillkeeper`)
  packages/
    i18n/               en/de/ru typed catalogs + lookup (TypeScript)
  docs/                 mkdocs site (this site)
  .github/workflows/    CI: lint, typecheck, test+coverage, build, release
  AGENTS.md  CLAUDE.md  CONTRIBUTING.md  README.md  CHANGES.md  LICENSE
  Cargo.toml  rust-toolchain.toml
  package.json  pnpm-workspace.yaml  tsconfig.base.json
```
