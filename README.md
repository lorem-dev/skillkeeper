# SkillKeeper

SkillKeeper installs and manages skills and hooks for AI coding agents
(Claude, Codex, Copilot, Cursor, OpenCode), both per-project and globally.
Skills are distributed through Git repositories. SkillKeeper ships a CLI and
an Electron desktop app. Target platforms: Linux, macOS, Windows.

---

## Prerequisites

- Node 20 or later
- pnpm (install via corepack):

```bash
corepack enable
```

---

## Install dependencies

```bash
pnpm install
```

---

## Run tests

```bash
pnpm test
```

For the full coverage gate (90% required):

```bash
pnpm test:cov
```

---

## Lint and typecheck

```bash
pnpm lint
pnpm typecheck
```

---

## Build

```bash
pnpm build
```

---

## Run the CLI (development)

```bash
pnpm --filter @skillkeeper/cli dev
```

Or after building:

```bash
node packages/cli/dist/index.js --help
```

---

## Run the desktop app (development)

```bash
pnpm --filter skillkeeper-desktop dev
```

---

## Documentation

Full documentation is in `docs/` and is built with mkdocs:

```bash
mkdocs serve
```

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
