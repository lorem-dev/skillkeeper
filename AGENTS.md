# AGENTS.md -- SkillKeeper

This file is addressed to AI coding agents. Read it fully before touching code.

**Must read:** [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## Project Overview

SkillKeeper installs and manages "skills" (and their "hooks") for AI coding
agents -- Claude, Codex, Copilot, Cursor, and OpenCode -- both per-project and
globally on a developer's machine. Skills are directories distributed through
Git repositories (including private GitHub and Bitbucket repositories over SSH
with Git LFS). SkillKeeper ships two front ends over one shared Rust domain
core: a CLI (primary interface for v1) and a desktop GUI (Tauri v2 + React).
Target platforms: Linux, macOS, Windows.

---

## Monorepo Layout

The repository is a Cargo (Rust) workspace and a pnpm workspace side by side.

```
skillkeeper/
  crates/                         Rust workspace members
    skillkeeper-core/     domain model, resolver, hashing, install engine, hooks,
                          verify/repair, git port, scheduler, adapter interface, MCP
    skillkeeper-config/   sectioned config loading + validation (serde)
    skillkeeper-agents/   adapter registry + Claude/Codex/Copilot/Cursor/OpenCode adapters
    skillkeeper-cli/      clap-based CLI (binary name `skillkeeper`)
  packages/
    i18n/       message catalogs for all supported locales (16 languages),
                generated from locales/*.po (en.po canonical) + lookup fn
                (the only remaining TypeScript package)
  apps/
    desktop/    Tauri v2 desktop app
      src-tauri/    Rust backend (a Cargo workspace member): commands, PTY, state
      src/renderer/ React + Zustand renderer
  docs/         mkdocs site (English-only; docs/ui/ = design-system reference)
  .agents/skills/   local development skills (see below)
  .github/workflows/  CI pipelines
  AGENTS.md  CLAUDE.md  CONTRIBUTING.md  README.md  CHANGES.md  LICENSE
  Cargo.toml  rust-toolchain.toml  package.json  pnpm-workspace.yaml  tsconfig.base.json
```

The Rust dependency graph is acyclic: `skillkeeper-core` has no internal deps;
`skillkeeper-config` and `skillkeeper-agents` depend only on `skillkeeper-core`;
`skillkeeper-cli` and the desktop backend (`apps/desktop/src-tauri`) depend on
`skillkeeper-core`, `skillkeeper-config`, and `skillkeeper-agents`. The renderer
consumes the Rust types as ts-rs-generated TypeScript and the `@skillkeeper/i18n`
catalogs.

---

## Running the Gates

Prerequisites: a stable Rust toolchain via rustup (pinned in
`rust-toolchain.toml`, with `rustfmt` and `clippy`), Node 22.13+, and pnpm via
`corepack enable`. On Linux the desktop app also needs the platform webview and
GTK development libraries Tauri builds against (webkit2gtk 4.1, GTK 3, libsoup3
and related `-dev` packages).

```bash
corepack enable
pnpm install

# Rust (crates + Tauri backend)
cargo fmt --check   # formatting
cargo clippy        # lints
cargo test          # tests; also regenerates the ts-rs bindings

# TypeScript (renderer + i18n)
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
pnpm test:cov       # Vitest with v8 coverage; fails below 90% (packages/i18n)
pnpm --filter @skillkeeper/desktop frontend:build   # vite build of the renderer
```

All of these must pass before a pull request is ready.

### Verification workflow

Run the full gate (`cargo fmt --check`, `cargo clippy`, `cargo test`,
`pnpm test:cov`, `pnpm typecheck`, and the renderer `frontend:build`) as a single
dedicated step at the END of a change -- not after every task. While iterating,
write only the minimal tests needed to guarantee the code works, and run just the
focused test for what you changed (at most a quick `cargo test -p <crate>` or a
typecheck of the renderer). The comprehensive gate above is the single final
check before a change is considered done or a pull request opened.

---

## App Packaging

Desktop packaging uses the Tauri bundler (`pnpm --filter @skillkeeper/desktop
build`, which runs `tauri build`). Bundle targets are configured in
`apps/desktop/src-tauri/tauri.conf.json` (app, dmg, deb, appimage, nsis, msi).
The app icon sources are `assets/icons/icon-default.png` (light) and
`icon-dark.png` (dark), plus the renderer glyph SVGs under
`apps/desktop/src/renderer/shared/ui/Icon/assets/` for the macOS menu. The whole
platform set (`.icns`, `.ico`, the tiled logos, the runtime light/dark window
icons, and the `menu-icons/*` template glyphs) is generated from those by
`scripts/gen-icons.mjs` (`pnpm run icons`) into `apps/desktop/src-tauri/icons/`,
which is **git-ignored** -- never commit it. The set is consumed at `cargo build`
time (`include_bytes!`, `generate_context!`, the `resources` glob), so the
desktop crate's `build.rs` regenerates it when missing (fresh clone / `git
clean`); CI regenerates it explicitly before any cargo step. Re-run `pnpm run
icons` by hand after editing anything under `assets/icons/`.

---

## Conventions

### TypeScript

- Module system: `NodeNext`. All relative imports in source files must end with
  `.js` (the compiled extension), not `.ts`.
- `isolatedModules` and `verbatimModuleSyntax` are on. Mark every type-only export
  and import with `export type` / `import type`.
- The toolchain runs at the maximum practical strictness, configured once in
  `tsconfig.base.json` and inherited by every package. On top of `strict`:
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
  `noPropertyAccessFromIndexSignature`, `allowUnreachableCode: false`, and
  `allowUnusedLabels: false`. Treat `pnpm typecheck` as a hard gate: fix the code,
  never loosen a flag to make an error go away.
- `exactOptionalPropertyTypes` is the one strict flag deliberately left OFF. The
  domain shapes reach the renderer as ts-rs-generated types with clean `prop?: T`
  optionals, where this flag forces either `| undefined` type-widening (which
  negates it) or verbose conditional construction, for little real safety. Do not
  enable it without reworking those types first.
- No `any` without a comment explaining why it is safe.

### Text and Encoding

- All source code and documentation are ASCII-only. No Unicode punctuation
  (curly quotes, em dashes, ellipsis characters) outside of i18n catalogs and
  UI strings.
- Exception: `packages/i18n/` (the non-English catalogs, plus the native
  language-name table in `src/nativeNames.ts`) may contain non-ASCII characters
  because their text requires them. Non-ASCII UI text must live in this package,
  never inline in app/renderer source.

### Internationalization

**Full guide: [docs/usage/localization.md](./docs/usage/localization.md) -- read it before
touching any user-facing string or the i18n pipeline.**

- The single source of truth is the gettext `locales/<lang>.po` catalogs, NOT
  the TypeScript catalogs. `locales/en.po` is canonical (it defines the key set;
  `MessageKey` derives from it). Add or change a string by editing the `.po` and
  running `pnpm run i18n`, which regenerates `packages/i18n/src/catalogs/*.ts`
  (renderer) and `apps/desktop/src-tauri/locales/*.mo` (native macOS menu). Those
  generated sets are git-ignored, NOT committed -- they are produced on
  `pnpm install` (a `postinstall` hook) and by `src-tauri/build.rs`; never
  hand-edit them, and commit only the `.po` change.
- Default behaviour: new/changed UI strings go into `locales/en.po` only. Do NOT
  translate them into other locales as part of feature work -- untranslated keys
  fall back to English per key until a dedicated translation pass (before a
  release, or when explicitly asked), preserving `{token}` placeholders and the
  locale's CLDR plural categories.
- Adding a new selectable language touches ~10 places (`.po`, `gen-i18n.mjs`
  `LANGS`, `langs.ts`, `index.ts`, `lazy.ts`, `nativeNames.ts`, the config
  `Language` enum in `crates/skillkeeper-config/src/schema.rs`,
  `apps/desktop/src-tauri/src/app/i18n.rs`, renderer `domain/languages.ts`, and
  `Info.plist` `CFBundleLocalizations`) -- follow the checklist in
  docs/usage/localization.md. Store Chinese Simplified as `zh-cn`.
- The CLI is English-only by design; the native macOS menu localizes at startup,
  so a language change applies to the menu on the next launch.
- Language picker labels: do NOT rely on `Intl.DisplayNames` for the native
  name. The system WebView runtime ships a reduced ICU data set on some
  platforms, so `Intl.DisplayNames(['be']).of('be')` can return the bare code
  `be` (Belarusian then looks untranslated), and it renders our script codes as
  regions ("zh-cn" -> "Chinese (China)"). The native name comes from the pinned
  `NATIVE_NAMES` table in `apps/desktop/src/renderer/domain/languages.ts`; keep
  it in sync when adding a locale. `Intl.DisplayNames` is used only for the
  cross-locale qualifier, with a fallback to `NATIVE_NAMES`.

### Commit Rules

Follow CONTRIBUTING.md exactly:

- Conventional Commits types: `feat`, `fix`, `chore`, `docs`, `test`,
  `refactor`, `perf`, `ci`, `build`.
- English, imperative mood, subject under 72 characters.
- No AI-tool mentions anywhere in commit messages or trailers.
- Scopes only when already established in `git log`.

### Branching

`feature/*` -> `develop` -> `main` via Merge Request. Direct commits to `main`
are allowed only until the first release.

---

## CodeGraph

The project uses CodeGraph MCP tools (`codegraph_*`) for structural code
navigation. The index lives in `.codegraph/` which is git-ignored and not
shipped.

CodeGraph is an optional accelerator, not a project dependency. If the
`codegraph_*` tools are not installed or are otherwise unavailable in the
environment, do not require them and do not prompt the user to set them up:
silently fall back to the native search and read tools and continue. (This
differs from "installed but not initialized" - the no-index case below, where
offering to build the index is appropriate.)

When to use each tool:

- `codegraph_search` -- find a symbol by name (returns kind, location,
  signature).
- `codegraph_context` -- get focused context for a task or area (composes
  search + node + callers + callees in one call; use this first).
- `codegraph_callers` -- what calls a given function or method.
- `codegraph_callees` -- what a given function or method calls.
- `codegraph_impact` -- what would break if a symbol changed.
- `codegraph_node` -- a symbol's source, signature, or docstring.
- `codegraph_explore` -- deep survey of an unfamiliar module or pattern
  (token-heavy; use a subagent for large explorations).
- `codegraph_files` -- list files under a path.
- `codegraph_status` -- check index health.

Do not grep for symbol names when `codegraph_search` will answer faster and
more accurately.

---

## Superpowers

Design specs and implementation plans live in `.superpowers/` which is
git-ignored. When planning a multi-step task, write a plan there first. The
`superpowers:writing-plans` skill guides the process. CHANGES.md entries are
planned at the plan stage, not after the fact.

---

## Desktop UI Design System

The visual language for the desktop app is specified in
[docs/ui/design-system.md](./docs/ui/design-system.md): color palette, typography
(Inter), translucent "glass" materials, radii, spacing, elevation, motion, and
per-component rules. Read it before adding or restyling any renderer UI; build
components against the semantic tokens, never hardcoded hex/px values.

The tokens themselves are implemented once, in
`apps/desktop/src/renderer/styles/_tokens.scss` -- that SCSS file is the single
source of truth for the `--sk-*` custom properties (light + dark), and the spec
documents it rather than duplicating the values.

Style organization: `styles/` holds only the global foundation (`_tokens.scss`,
`_fonts.scss`, `_base.scss`), composed by `styles/index.scss` and imported once
from `main.tsx`. Component styles are co-located with their component (for example
`App.scss` next to `App.tsx`) and imported from that component's module, not from
`styles/`. Component styles reference `--sk-*` tokens only; never hardcode hex/px.

Bundled fonts live in `apps/desktop/src/renderer/assets/fonts/` (Inter as the
system face, Cormorant Garamond as an optional display face), each with its SIL OFL
license file.

### Storybook

The generic `shared/ui` kit has a Storybook for browsing components in
isolation, in both light and dark themes. Config lives in
`apps/desktop/.storybook/`; stories are co-located with their component as
`Component.stories.tsx`. Run it with
`pnpm --filter @skillkeeper/desktop run storybook` (port 6006); build the
static site with `build-storybook`. Storybook is a standalone dev tool -- it
runs the renderer under Vite without the Rust backend and is NOT part of the
lint/typecheck/test/build gates. When you add a `shared/ui` primitive, add
a story for it; pass display text as plain ASCII props (stories do not use
i18n, the same as the components themselves).

---

## Desktop Frontend Architecture (must read)

Before writing or restructuring renderer code, read the frontend architecture
docs in [apps/desktop/docs/](./apps/desktop/docs/):

- [architecture.md](./apps/desktop/docs/architecture.md) - the layered structure
  (FSD-inspired, under `src/renderer/`), import boundaries, barrels, naming, and
  how the renderer reaches the Rust backend over the bridge.
- [glossary.md](./apps/desktop/docs/glossary.md) - plain-language definitions of
  the layer and module terms.
- [decisions/readme.md](./apps/desktop/docs/decisions/readme.md) - the design
  decision log behind the structure.

The renderer holds state in Zustand and reaches the Rust backend only through the
typed bridge client at `apps/desktop/src/renderer/services/bridge/client.ts`,
which calls Rust `#[tauri::command]`s via Tauri `invoke` and subscribes to
backend events via `listen`. It imports the ts-rs-generated types under
`services/bridge/generated/` but never runs backend logic itself.

---

## Local Development Skills

Five skills live under `.agents/skills/`. Invoke them when the situation calls
for it:

| Skill | When to use |
|---|---|
| `check-changes` | After a batch of commits -- verify CHANGES.md (Development section) reflects every change. |
| `check-docs` | Before a release or after updating commands/options -- verify docs/ and README.md are current. |
| `run-tests-and-linters` | Before marking any task done -- run the full gate (lint, typecheck, test:cov at 90%). |
| `check-licenses` | After editing any `package.json` or `Cargo.toml` -- verify all npm and cargo dependencies are license-compliant and update LICENSE. |
| `pre-release-check` | Before cutting a release -- runs all four skills above plus version-bump and commit-format checks. |

---

## Security Notes

- The renderer is an unprivileged web UI: it has no filesystem or process
  access and can reach the host only through the Rust `#[tauri::command]`s
  wired into the bridge. Never widen that command surface (or the Tauri
  capability allowlist) without review, and keep every command re-validating
  its inputs in Rust.
- Git runs as a subprocess with argument arrays only. No shell string
  interpolation anywhere near user-supplied paths or URLs.
- Hook installation always requires separate, explicit user consent. Never
  install hooks implicitly.
- Do not introduce `eval`, `Function()`, or dynamic `require()` / `import()` of
  user-supplied paths.
