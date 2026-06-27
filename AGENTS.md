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
    i18n/       typed catalogs (en/de/ru) + lookup function
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

---

## Conventions

### TypeScript

- Module system: `NodeNext`. All relative imports in source files must end with
  `.js` (the compiled extension), not `.ts`.
- `isolatedModules` is on. Use `export type` / `import type` for type-only
  exports and imports.
- Strict mode is on. No `any` without a comment explaining why it is safe.

### Text and Encoding

- All source code and documentation are ASCII-only. No Unicode punctuation
  (curly quotes, em dashes, ellipsis characters) outside of i18n catalogs and
  UI strings.
- Exception: `packages/i18n/` catalogs for `de` and `ru` may contain non-ASCII
  characters because German and Russian text requires them.

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
