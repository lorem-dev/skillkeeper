# AGENTS.md -- SkillKeeper

This file is addressed to AI coding agents. Read it fully before touching code.

**Must read:** [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## Project Overview

SkillKeeper installs and manages "skills" (and their "hooks") for AI coding
agents -- Claude, Codex, Copilot, Cursor, and OpenCode -- both per-project and
globally on a developer's machine. Skills are directories distributed through
Git repositories (including private GitHub and Bitbucket repositories over SSH
with Git LFS). SkillKeeper ships two front ends over one shared domain core: a
CLI (primary interface for v1) and a desktop GUI (Electron + React). Target
platforms: Linux, macOS, Windows (plus MSIX for the Microsoft Store).

---

## Monorepo Layout

```
skillkeeper/
  packages/
    core/       domain model, resolver, hashing, install engine, hooks,
                verify/repair, git port, scheduler, adapter interface
    config/     YAML + zod sectioned validation
    agents/     adapter registry + Claude/Codex/Copilot/Cursor/OpenCode adapters
    i18n/       typed catalogs (en source + translations) + lookup function
    cli/        commander-based CLI
  apps/
    desktop/    Electron main/preload/renderer (React + Zustand); shell only in v1
  docs/         mkdocs site
  .agents/skills/   local development skills (see below)
  .github/workflows/  CI pipelines
  AGENTS.md  CLAUDE.md  CONTRIBUTING.md  README.md  CHANGES.md  LICENSE
  package.json  pnpm-workspace.yaml  tsconfig.base.json
```

The dependency graph is acyclic: `core` has no internal deps; `config` and
`agents` depend only on `core`; `cli` and `desktop` depend on `core`, `config`,
`agents`, and `i18n`.

---

## Running the Gates

Prerequisites: Node 20+, pnpm via `corepack enable`.

```bash
corepack enable
pnpm install

pnpm lint          # ESLint across all packages
pnpm typecheck     # tsc --noEmit across all packages
pnpm test:cov      # Vitest with v8 coverage; fails below 90% lines/branches
pnpm build         # tsc project references for all packages + electron-vite for desktop
```

All four commands must pass before a pull request is ready.

### Verification workflow

Run the full coverage and type verification (`pnpm test:cov`, `pnpm typecheck`,
`pnpm build`) as a single dedicated step at the END of a change -- not after
every task. While iterating, write only the minimal tests needed to guarantee
the code works, and run just the focused test for what you changed (at most a
quick typecheck of the package you touched). The comprehensive gate above is the
single final check before a change is considered done or a pull request opened.

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
  domain model uses clean `prop?: T` optionals and is largely produced by zod
  parsing, where this flag forces either `| undefined` type-widening (which negates
  it) or verbose conditional construction, for little real safety. Do not enable it
  without reworking those types first.
- No `any` without a comment explaining why it is safe.

### Text and Encoding

- All source code and documentation are ASCII-only. No Unicode punctuation
  (curly quotes, em dashes, ellipsis characters) outside of i18n catalogs and
  UI strings.
- Exception: `packages/i18n/` catalogs (all non-English locales) may contain
  non-ASCII characters because their text requires them.

### Internationalization

- `packages/i18n/src/catalogs/en.ts` is the source of truth: every message key
  and its English value live there. Other locales are `Partial<Catalog>` and
  fall back to English per-key at runtime.
- Default behaviour: new/changed UI strings are added to `en.ts` only. Do NOT
  translate them into other locales as part of feature work -- untranslated
  keys simply show English until they are localized.
- Translations are added in a dedicated pass BEFORE a release (or when the user
  explicitly asks to add/complete a language). At that point, translate the
  full catalog for the target locale(s), preserving `{token}` placeholders and
  providing the CLDR plural categories that locale uses.
- To add a new selectable language: extend `Lang` and the `catalogs` map in
  `packages/i18n/src/index.ts`, the `language` enum in
  `packages/config/src/schema.ts`, and `LANGS` in
  `apps/desktop/src/renderer/domain/languages.ts`. Store Chinese Simplified as
  `zh-cn`.

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
does not run under electron-vite and is NOT part of the
lint/typecheck/test:cov/build gates. When you add a `shared/ui` primitive, add
a story for it; pass display text as plain ASCII props (stories do not use
i18n, the same as the components themselves).

---

## Desktop Frontend Architecture (must read)

Before writing or restructuring renderer code, read the frontend architecture
docs in [apps/desktop/docs/](./apps/desktop/docs/):

- [architecture.md](./apps/desktop/docs/architecture.md) - the layered structure
  (FSD-inspired, under `src/renderer/`), import boundaries, barrels, naming, and
  how the renderer consumes the workspace packages over the IPC bridge.
- [glossary.md](./apps/desktop/docs/glossary.md) - plain-language definitions of
  the layer and module terms.
- [decisions/readme.md](./apps/desktop/docs/decisions/readme.md) - the design
  decision log behind the structure.

The renderer holds state in Zustand and reaches the Electron main process only
through the typed `window.skillkeeper` IPC bridge; it imports types from the
`@skillkeeper/*` packages but never calls their runtime directly.

---

## Local Development Skills

Five skills live under `.agents/skills/`. Invoke them when the situation calls
for it:

| Skill | When to use |
|---|---|
| `check-changes` | After a batch of commits -- verify CHANGES.md (Development section) reflects every change. |
| `check-docs` | Before a release or after updating commands/options -- verify docs/ and README.md are current. |
| `run-tests-and-linters` | Before marking any task done -- run the full gate (lint, typecheck, test:cov at 90%). |
| `check-licenses` | After editing any `package.json` -- verify all dependencies are license-compliant and update LICENSE. |
| `pre-release-check` | Before cutting a release -- runs all four skills above plus version-bump and commit-format checks. |

---

## Security Notes

- The renderer runs sandboxed (`contextIsolation` on, `nodeIntegration` off,
  `sandbox` on). Never add Node APIs to the preload bridge without review.
- Git runs as a subprocess with argument arrays only. No shell string
  interpolation anywhere near user-supplied paths or URLs.
- Hook installation always requires separate, explicit user consent. Never
  install hooks implicitly.
- Do not introduce `eval`, `Function()`, or dynamic `require()` / `import()` of
  user-supplied paths.
