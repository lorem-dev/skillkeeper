# Development

## Prerequisites

- Node.js 22.13 or later (`engines.node >= 22.13` is enforced).
- pnpm 11 (`packageManager: pnpm@11.9.0` is pinned in `package.json`).
- System `git`.

## Setup

Clone the repository and install dependencies:

```
git clone git@github.com:lorem-dev/skillkeeper.git
cd skillkeeper
pnpm install
```

## Monorepo structure

SkillKeeper is a pnpm workspaces monorepo. Packages live under `packages/`;
the desktop app lives under `apps/`. See [Architecture](architecture.md) for
the full package graph.

## Common scripts

Run from the repository root:

| Script         | Description                                    |
|----------------|------------------------------------------------|
| `pnpm build`   | Build all packages (tsc project references).   |
| `pnpm test`    | Run all tests.                                 |
| `pnpm test:cov`| Run tests with v8 coverage report.             |
| `pnpm lint`    | Run ESLint across all packages.                |
| `pnpm typecheck`| Type-check all packages.                      |
| `pnpm format`  | Run Prettier across all packages.              |

Run a script for a single package:

```
pnpm --filter @skillkeeper/core test
pnpm --filter @skillkeeper/cli typecheck
```

## Testing

Tests use Vitest. The coverage gate is **90% lines and branches**; CI fails
below this threshold.

The core is tested with in-memory fakes for all I/O:

- `createMemFs` - an in-memory `FsPort` implementation used throughout core
  tests. No real filesystem operations.
- `fakeGit` - a fake `GitPort` that returns predetermined results. No network
  or real Git invocation.

This design means core unit tests are fast, deterministic, and run without any
network access or external tools.

Adapter tests for each agent use fixture trees to test path resolution and
discovery independently.

### Concurrency tests

Node.js is single-threaded, so Go-style data-race detection does not apply.
The equivalent guarantee here is explicit tests for concurrent operations (for
example parallel installs and simultaneous update checks) that assert correct
serialization and atomic state writes. This is documented in the test suite
rather than silently omitted.

## TypeScript

All packages use TypeScript in strict mode with `noUncheckedIndexedAccess: true`.
Types are inferred from zod schemas where applicable (config sections, skill
manifests, repository config). Never use `any`; use `unknown` and narrow.

## Code style

ESLint + Prettier are enforced. Format before committing:

```
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

Runtime dependencies are intentionally minimal. The allowed direct runtime
dependencies are: `yaml`, `zod`, `commander`, `react`, `react-dom`, `zustand`.

Every new direct dependency must:

1. Pass the license policy in `CONTRIBUTING.md` (compatible with Apache-2.0;
   GPL, AGPL, LGPL, SSPL, BSL, CC-NC, and Commons Clause are disallowed).
2. Be justified in the pull request description.

## Adding an agent adapter

1. Create `packages/agents/src/<agent-name>.ts` implementing `AgentAdapter`.
2. Add `registerBuiltinAgents` call in `packages/agents/src/index.ts`.
3. Add a focused test in `packages/agents/src/<agent-name>.test.ts` covering
   `destinationRoot`, `discoverInstalled`, and `hookSupport`.
4. No other packages need to change.

## Changelog

Every change set adds a bullet under the `Development` heading in `CHANGES.md`
before merging. At release, development bullets are moved under a version
heading. Each bullet is short; large items link to documentation rather than
describing details inline.
