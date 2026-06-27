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

## Run the CLI

Build the workspace once, then run the CLI entry point:

```bash
pnpm build:libs
node packages/cli/dist/main.js --help
```

---

## Run the desktop app (development)

```bash
pnpm dev
```

This is a shortcut for `pnpm --filter @skillkeeper/desktop dev` (electron-vite
with hot reload). The Electron binary is downloaded automatically on
`pnpm install`.

To build and preview the production app, or to produce installers:

```bash
pnpm build
pnpm --filter @skillkeeper/desktop start      # preview the built app
pnpm --filter @skillkeeper/desktop package    # build installers (dmg/AppImage/nsis/MSIX)
```

---

## Troubleshooting

If `pnpm dev` fails with `Error: Electron uninstall`, the Electron binary was
not downloaded. Re-run the installer:

```bash
node scripts/ensure-electron.mjs
```

(`pnpm install` runs this automatically; it is a no-op once the binary is
present.)

---

## Documentation

Full documentation is in `docs/` and is built with mkdocs:

```bash
mkdocs serve
```

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
