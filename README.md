# SkillKeeper

SkillKeeper installs and manages skills and hooks for AI coding agents
(Claude, Codex, Copilot, Cursor, OpenCode), both per-project and globally.
Skills are distributed through Git repositories. SkillKeeper ships a CLI and
a Tauri desktop app over a shared Rust domain core. Target platforms: Linux,
macOS, Windows.

---

## Prerequisites

- A stable Rust toolchain via rustup. The pinned channel and the `rustfmt`
  and `clippy` components are declared in `rust-toolchain.toml`; rustup
  installs them automatically on first build.
- Node 22.13 or later.
- pnpm (install via corepack):

```bash
corepack enable
```

- On Linux, the desktop app needs the platform webview and GTK development
  libraries that Tauri builds against (for example webkit2gtk 4.1, GTK 3,
  libsoup3, and the related `-dev` packages). Install them through your
  distribution's package manager.

---

## Install dependencies

```bash
pnpm install
```

---

## Run tests

Rust crates and the Tauri backend:

```bash
cargo test
```

`cargo test` also regenerates the ts-rs bindings the renderer imports.

The remaining TypeScript (the renderer and the `packages/i18n` catalogs):

```bash
pnpm test
```

For the coverage gate (90% on `packages/i18n`):

```bash
pnpm test:cov
```

---

## Lint and typecheck

```bash
cargo fmt --check
cargo clippy
pnpm lint
pnpm typecheck
```

---

## Run the CLI

The CLI is the `skillkeeper-cli` crate:

```bash
cargo run -p skillkeeper-cli -- --help
```

To build a release binary:

```bash
cargo build --release -p skillkeeper-cli
```

---

## Run the desktop app (development)

```bash
pnpm dev
```

This is a shortcut for `pnpm --filter @skillkeeper/desktop dev`, which runs
`tauri dev` (the Rust backend plus the Vite renderer with hot reload).

To build the production app and installers:

```bash
pnpm --filter @skillkeeper/desktop build      # tauri build (bundles per platform)
```

To rebuild only the renderer bundle:

```bash
pnpm --filter @skillkeeper/desktop frontend:build   # vite build
```

To regenerate the app icons from the sources in `assets/icons/`:

```bash
pnpm run icons      # scripts/gen-icons.mjs -> apps/desktop/src-tauri/icons/ (git-ignored)
```

---

## Documentation

The published documentation lives at
<https://lorem-dev.github.io/skillkeeper/> (versioned via mike, with a version
switcher in the header).

Full documentation is in `docs/` and is built with
[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/). The docs are
English-only.

```bash
pnpm docs:serve   # serve the docs locally with live reload
pnpm docs:build   # render the static site to site/
```

`scripts/ensure-mkdocs.mjs` runs mkdocs through [uv](https://docs.astral.sh/uv/)
(`uv run --with mkdocs-material mkdocs ...`), which resolves and caches the docs
toolchain on first use -- no global Python setup and no virtualenv to manage,
only `uv` on `PATH`. `pnpm docs:install` warms that cache without serving.

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
