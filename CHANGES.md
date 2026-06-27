# SkillKeeper Changelog

## Development

### Breaking Changes

- None.

### Features

- Scaffold the pnpm and TypeScript monorepo: packages `core`, `config`, `agents`,
  `i18n`, `cli`, and the `desktop` Electron app, with shared ESLint, Prettier,
  Vitest, and a 90% coverage gate.
- Add the domain core: skill resolution (flat, grouped, and repo-config schemes),
  SHA-256 hashing, hook management (delimited-text and JSON-merge strategies),
  install, uninstall, verify, and repair, the agent adapter framework, the system
  git port, and the update scheduler.

### Fixes

- None.
