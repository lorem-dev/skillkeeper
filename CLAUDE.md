# SkillKeeper

SkillKeeper is a TypeScript/pnpm monorepo that installs and manages "skills"
(and their "hooks") for AI coding agents -- Claude, Codex, Copilot, Cursor, and
OpenCode. It ships a commander-based CLI and an Electron + React desktop app
over a shared domain core (`@skillkeeper/core`). The monorepo contains five
packages (`core`, `config`, `agents`, `i18n`, `cli`) and one Electron app
(`apps/desktop`). Target platforms: Linux, macOS, Windows. All source and
documentation are ASCII-only; the only non-ASCII text lives in the `i18n`
catalogs for German and Russian.

---

**Must read:**

- [AGENTS.md](./AGENTS.md) -- architecture, layout, gates, conventions,
  CodeGraph usage, local skills.
- [CONTRIBUTING.md](./CONTRIBUTING.md) -- commit rules, dependency license
  policy, GPG signing.
