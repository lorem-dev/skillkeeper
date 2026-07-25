# Development

## Prerequisites

- A stable Rust toolchain via `rustup`. The channel is pinned in
  `rust-toolchain.toml` (`stable`, with the `rustfmt` and `clippy` components).
- Node.js 22.13 or later (`engines.node >= 22.13` is enforced).
- pnpm via `corepack enable` (`packageManager` is pinned in `package.json`).
- System `git`.
- On Linux, the platform webview and GTK development libraries Tauri v2 needs
  (for example webkit2gtk 4.1, GTK 3, libsoup3, and the related `-dev`
  packages).

## Setup

Clone the repository and install dependencies:

```
git clone --recurse-submodules git@github.com:lorem-dev/skillkeeper.git
cd skillkeeper
pnpm install
```

If you cloned without `--recurse-submodules`, fetch the one submodule
(`examples/test-repo`, the end-to-end fixture) with:

```
git submodule update --init
```

Nothing compiles, lints, or unit-tests against it, so the ordinary commands below
work without it -- only `pnpm test:e2e` needs it.

## Monorepo structure

SkillKeeper has two workspaces. A Cargo (Rust) workspace holds the domain crates
under `crates/` (`skillkeeper-core`, `skillkeeper-config`, `skillkeeper-agents`,
`skillkeeper-cli`) and the desktop backend (`apps/desktop/src-tauri`). A pnpm
workspace holds the desktop renderer (`apps/desktop`) and the one remaining
TypeScript package (`packages/i18n`). See [Architecture](architecture.md) for
the full package graph.

Install the JavaScript/TypeScript dependencies with `pnpm install`; Cargo
resolves the Rust dependencies on first build.

## Common commands

Rust workspace (run from the repository root):

| Command                        | Description                               |
|--------------------------------|-------------------------------------------|
| `cargo build`                  | Build the Rust workspace.                 |
| `cargo test`                   | Run Rust tests (also regenerates ts-rs bindings). |
| `cargo fmt --check`            | Check Rust formatting.                     |
| `cargo clippy`                 | Lint the Rust workspace.                   |
| `cargo run -p skillkeeper-cli -- --help` | Run the CLI locally.            |

TypeScript side (run from the repository root):

| Command          | Description                                     |
|------------------|-------------------------------------------------|
| `pnpm test`      | Run the TypeScript tests (`vitest run`).        |
| `pnpm test:cov`  | Run tests with v8 coverage report.              |
| `pnpm test:e2e`  | Run the end-to-end suite against the built CLI.  |
| `pnpm lint`      | Run ESLint.                                      |
| `pnpm typecheck` | Type-check the TypeScript packages.             |
| `pnpm format`    | Run Prettier.                                    |
| `pnpm --filter @skillkeeper/desktop frontend:build` | Build the renderer bundle (`vite build`). |

The desktop app runs and packages through Tauri:

```
pnpm --filter @skillkeeper/desktop dev     # tauri dev
pnpm --filter @skillkeeper/desktop build   # tauri build (installers)
```

Note: the legacy root `pnpm build` / `pnpm build:libs` scripts are not a
reliable gate; use the per-tool commands above.

## Documentation

The documentation site is built from `docs/` with Material for MkDocs and is
English-only:

```
pnpm docs:serve   # serve the docs locally with live reload
pnpm docs:build   # render the static site to site/
pnpm docs:install # warm the toolchain cache without serving
```

`scripts/ensure-mkdocs.mjs` runs mkdocs through [uv](https://docs.astral.sh/uv/)
(`uv run --with mkdocs-material mkdocs ...`), which resolves and caches the docs
toolchain on first use, so there is no global Python setup and no virtualenv to
manage - only `uv` on `PATH`. The published site is versioned with mike; see
[Releasing](releasing.md).

## Testing

The Rust crates are tested with `cargo test`. Running the crate tests also
regenerates the ts-rs TypeScript bindings under
`apps/desktop/src/renderer/services/bridge/generated/`, so Rust stays the single
source of truth for the renderer's request/response types.

The core is tested against in-memory fakes for all I/O rather than the real
host:

- An in-memory `FsPort` implementation (`MemFs` in `skillkeeper-core::testing`)
  stands in for the filesystem. No real filesystem operations.
- A fake git port returns predetermined results. No network or real Git
  invocation.

This design means core unit tests are fast, deterministic, and run without any
network access or external tools.

Adapter tests for each agent use fixture trees to test path resolution and
discovery independently.

The TypeScript side uses Vitest. The **90% lines and branches** coverage gate
(`pnpm test:cov`) applies to `packages/i18n`; CI fails below this threshold.

### End-to-end tests

In-memory fakes make the unit tests fast and deterministic, but they cannot catch
a regression that lives in the wiring between the CLI, the agent adapters, and a
real filesystem -- an adapter resolving the wrong destination root, say, or a
skill that resolves under `MemFs` but not on disk. The end-to-end suite covers
exactly that layer: it drives the real `skillkeeper` binary against a real Git
working tree and asserts on the files it produces.

```
pnpm test:e2e
```

That script initializes the `examples/test-repo` submodule, force-pulls it to the
tip of its branch, builds `target/debug/skillkeeper`, and then runs the specs.
Set `SKILLKEEPER_E2E_PIN_FIXTURE=1` to run against the fixture commit this
repository pins instead of pulling -- CI does that, so a build fails for reasons
in the diff rather than because the fixture moved.

Layout:

```
e2e/
  package.json       scopes the directory to CommonJS (the repo root is ESM)
  tsconfig.json      its own TypeScript scope; ts-jest type-checks as it transpiles
  src/cli.ts         the Sandbox harness: the only way a spec invokes the CLI
  tests/
    fixture.spec.ts  the submodule is present and still the shape the suite assumes
    skills.spec.ts   resolution schemes, executables, guidance, hooks
    mcp.spec.ts      preset discovery, parameters, ledgers, the Codex skip
    repair.spec.ts   verify -> repair -> verify, and the bounds on repair
```

Two things about the design are worth knowing before adding a spec:

- **The runner is Jest, not Vitest.** The two cover different layers and never
  overlap: Vitest runs pure logic in-process under the coverage gate, Jest drives
  a subprocess against the filesystem. Jest's config is `jest.config.cjs`, and the
  suite is deliberately CommonJS so no `--experimental-vm-modules` is needed.
- **Isolation belongs to the harness.** `Sandbox` (in `e2e/src/cli.ts`) always
  sets throwaway `HOME` *and* `XDG_CONFIG_HOME`. The first relocates the agents'
  global roots (a Codex MCP install always writes to `~/.codex/config.toml`, and
  global-scope skill installs write under `~`); the second relocates `state.json`
  and `config.yaml`. Forgetting either would edit the real machine, so specs never
  spawn the binary themselves -- always go through `Sandbox`.

The `check-fixture-repo` local skill wraps this suite and explains how to read a
failure: whether the fixture drifted, the product changed, or the harness leaked.
It is part of `pre-release-check`.

## TypeScript

The renderer and `packages/i18n` use TypeScript in strict mode with
`noUncheckedIndexedAccess: true`. The renderer's backend types are generated
from the Rust structs via ts-rs (`#[ts(export)]`); do not hand-edit the files
under `services/bridge/generated/`. Never use `any`; use `unknown` and narrow.

## Code style

Rust is formatted with `rustfmt` and linted with `clippy`; the TypeScript side
uses ESLint + Prettier. All are enforced in CI. Format and lint before
committing:

```
cargo fmt
cargo clippy
pnpm format
pnpm lint
```

## Branching model

```
main        release branch (Merge Request only after v1)
develop     integration branch (feature branches merge here)
feature/*   feature work, branched from develop
```

Workflow:

1. Branch from `develop`:
   ```
   git checkout develop
   git checkout -b feature/my-feature
   ```
2. Develop, commit, push.
3. Open a Merge Request from `feature/my-feature` to `develop`.
4. At release: open a Merge Request from `develop` to `main`.

Direct commits to `main` are allowed only until the first release.

## Commit conventions

- Conventional Commits format.
- English, imperative mood.
- Subject under 72 characters.
- No AI-tool mentions anywhere in commits.
- Scopes only when already established in the git log.
- GPG signing is strongly recommended (temporarily disabled during initial
  scaffolding).

## Adding a dependency

Runtime dependencies are intentionally minimal on both the Cargo and npm sides.
Every new direct dependency (Cargo crate or npm package) must:

1. Pass the license policy in `CONTRIBUTING.md` (compatible with Apache-2.0;
   GPL, AGPL, LGPL, SSPL, BSL, CC-NC, and Commons Clause are disallowed).
2. Be justified in the pull request description.

## Adding an agent adapter

1. Add `crates/skillkeeper-agents/src/<agent-name>.rs` that builds an
   `AgentAdapter` (see the existing `claude_adapter`, `codex_adapter`, etc.).
2. Register it in `register_builtin_agents` / `builtin_adapters`
   (`crates/skillkeeper-agents/src/registry.rs`) and declare the module in
   `lib.rs`.
3. Add focused tests covering the destination root, installed-skill discovery,
   and hook support.
4. No other crates need to change.

## Changelog

Every change set adds a bullet under the `Development` heading in `CHANGES.md`
before merging. At release, development bullets are moved under a version
heading. Each bullet is short; large items link to documentation rather than
describing details inline.
