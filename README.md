<h1 align="center">
  <img src="/docs/assets/logo.png" width="24" alt="SkillKeeper Logo">
  SkillKeeper
</h1>

<p align="center">
  <a href="https://github.com/lorem-dev/skillkeeper/releases/latest"><img src="https://img.shields.io/github/v/release/lorem-dev/skillkeeper?label=download" alt="Download"></a>
  <a href="https://lorem-dev.github.io/skillkeeper/"><img src="https://img.shields.io/badge/docs-online-blue" alt="Documentation"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/lorem-dev/skillkeeper" alt="License"></a>
  <a href="https://github.com/lorem-dev/skillkeeper/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-90%25-brightgreen" alt="Coverage"></a>
  <a href="https://github.com/lorem-dev/skillkeeper/actions/workflows/ci.yml"><img src="https://github.com/lorem-dev/skillkeeper/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
SkillKeeper installs and manages skills and hooks for AI coding agents
(Claude, Codex, Copilot, Cursor, OpenCode).
</p>

<p align="center">
  <img src="/docs/assets/screenshot.webp" width="640" alt="Screenshot of the SkillKeeper desktop app">
</p>

---

## Overview

SkillKeeper comes in two forms over one shared Rust core:

- A **desktop app** for browsing and installing Git repositories of skills,
  their hooks, and sets of MCP server presets - for AI coding agents, either
  per-project or globally.
- A **command-line tool** (`skillkeeper`) that does the same from your shell
  and in scripts.

Skills are distributed as Git repositories; a repository can also ship MCP
server presets. SkillKeeper clones a repository, resolves what it provides,
installs the parts you choose into the agents you target, and tracks everything
for updates. Supported agents: Claude, Codex, Copilot, Cursor, and OpenCode.

## Install

**Desktop app** -- download the bundle for your platform from the
[latest release](https://github.com/lorem-dev/skillkeeper/releases/latest).

**CLI** (`skillkeeper`) -- one line, using only tools already on your system. The
script detects your platform, downloads the matching CLI archive from the latest
release, and adds the binary to your PATH.

macOS / Linux:

```shell
curl -fsSL https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.ps1 | iex
```

See [Getting Started](https://lorem-dev.github.io/skillkeeper/latest/getting-started/)
for other options.

Hitting an install problem (for example macOS reporting the app as "damaged")?
See [Troubleshooting](https://lorem-dev.github.io/skillkeeper/latest/troubleshooting/).

---

## CLI quick start

The CLI binary is `skillkeeper`. Every command exits non-zero on failure.

Add a repository of skills, then see what it provides:

```shell
skillkeeper repo add git@github.com:example/skills.git
skillkeeper skill list
```

Install a skill for an agent (per-project by default; add `--global` for
machine-wide). Hooks are privileged and only installed with `--allow-hooks`:

```shell
skillkeeper skill install <skill-id> --agent claude
skillkeeper skill install <skill-id> --agent codex --global --allow-hooks
```

Track a project, then check for available updates across its repositories and
installed skills:

```shell
skillkeeper project add .
skillkeeper check
```

Inspect, verify against the manifest, and repair an installation:

```shell
skillkeeper skill info <skill-id>
skillkeeper skill verify <skill-id>
skillkeeper skill repair <skill-id>
```

Supported agents are `claude`, `codex`, `copilot`, `cursor`, and `opencode`.
Run `skillkeeper --help` (or `<command> --help`) for the full command set, also
documented in the
[CLI Reference](https://lorem-dev.github.io/skillkeeper/latest/usage/cli/).

---

## Repositories

A repository is any Git remote (SSH or HTTPS, public or private) that contains
one or more skills, and optionally MCP server presets. A skill is a directory
with a manifest plus the files it installs; hooks are opt-in edits a skill can
make to an agent's configuration. To publish your own skills, create a Git
repository with that layout and point SkillKeeper at it with `repo add`.

See [Repositories](https://lorem-dev.github.io/skillkeeper/latest/usage/repositories/)
and [Skills and Hooks](https://lorem-dev.github.io/skillkeeper/latest/usage/skills-and-hooks/)
for the repository format and authoring guide.

---

## Development

SkillKeeper is a Rust + pnpm monorepo: a Cargo workspace of domain crates
(`skillkeeper-core`, `skillkeeper-config`, `skillkeeper-agents`,
`skillkeeper-cli`) with a Tauri v2 + React desktop app, all over one shared
Rust core.

See the
[Development guide](https://lorem-dev.github.io/skillkeeper/latest/development/development/)
for setup, commands, and conventions.

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
