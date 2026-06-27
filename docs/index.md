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

Linux, macOS, Windows. Windows also ships an MSIX package for the Microsoft
Store.

## Two front ends, one core

SkillKeeper ships two front ends over one shared, framework-agnostic core:

- **CLI** - the primary interface for v1; suitable for scripting and headless
  use.
- **Desktop app** - Electron + React. v1 delivers the application shell, IPC
  bridge, state store, and navigation skeleton. Detailed screens are specified
  in a follow-up document.

## Quick links

- [Getting Started](getting-started.md) - install, add a repository, install
  your first skill.
- [Skills and Hooks](skills-and-hooks.md) - skill format, hook strategies,
  resolution schemes.
- [CLI Reference](cli.md) - every command and option.
- [Configuration](configuration.md) - `config.yaml` sections and defaults.
- [Architecture](architecture.md) - package graph, process boundaries, domain
  model.

## What SkillKeeper does NOT do (v1)

- Vulnerability scanning (a seam exists; no implementation in v1).
- Publishing skills (SkillKeeper consumes repositories; it does not author
  them).
- Auto-resolving SSH key passphrases (delegated to the user's ssh-agent).
- Detailed desktop UI screens beyond the shell.
