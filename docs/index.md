# SkillKeeper

SkillKeeper installs and manages **skills** and **hooks** for AI coding agents,
both per-project and globally on a machine.

A **skill** is a directory containing a `SKILL.md` file plus supporting files.
A **hook** is an optional privileged add-on inside a skill that modifies an
agent's own configuration. Skills are distributed through Git repositories
(including private GitHub and Bitbucket repositories) and are installed into
the locations expected by each supported agent.

## Supported agents

Claude, Codex, Copilot, Cursor, OpenCode.

## Platforms

Linux, macOS, Windows.

## Two front ends, one core

SkillKeeper ships two front ends over one shared, framework-agnostic core:

- **CLI** - the primary interface for v1; suitable for scripting and headless
  use.
- **Desktop app** - Tauri v2 (Rust backend) + a React 19 renderer. The renderer
  reaches the backend through a typed Tauri command/event bridge; the backend is
  the authority for the filesystem, Git, config, and state.

## Quick links

- [Getting Started](getting-started.md) - install, add a repository, install
  your first skill.
- [Skills and Hooks](usage/skills-and-hooks.md) - skill format, hook strategies,
  resolution schemes.
- [Repositories](usage/repositories.md) - adding repositories, branch tracking,
  update detection, and how Git is invoked.
- [Projects](usage/projects.md) - tracked project folders, per-project agent
  selection, and reconciliation.
- [MCP Servers](usage/mcp.md) - MCP presets, the `mcp.yml` format, install/update/
  remove, and per-agent native config.
- [CLI Reference](usage/cli.md) - every command and option.
- [Configuration](usage/configuration.md) - `config.yaml` sections and defaults.
- [Architecture](development/architecture.md) - package graph, process boundaries, domain
  model.

## What SkillKeeper does NOT do (v1)

- Vulnerability scanning (a seam exists; no implementation in v1).
- Publishing skills (SkillKeeper consumes repositories; it does not author
  them).
- Auto-resolving SSH key passphrases (delegated to the user's ssh-agent).
- Detailed desktop UI screens beyond the shell.
