# MCP Servers

See also: [Skills and Hooks](skills-and-hooks.md) (the guidance mechanism
MCP `rules` reuses), [Repositories](repositories.md) (a repository can
declare MCP presets alongside skills), and [Projects](projects.md) (MCP
installs use the same per-project targets as skills).

## Overview

An MCP (Model Context Protocol) server is an external tool/context provider
an agent can call into. SkillKeeper manages MCP server **presets** and
installs them into a project's agents, alongside skills.

A preset comes from one of two origins:

- **Manual** - defined by the user in SkillKeeper's own configuration
  (`config.yaml`, section `mcp`). Editable at any time; editing a preset can
  later update every install made from it.
- **Repo** - declared in a repository's `mcp.yml`/`mcp.yaml` file. Read-only:
  it can only change by editing the file in the repository and syncing.
  Updated implicitly whenever the repository is fetched.

Installing a preset renders it into the native MCP configuration format of
one or more agents (Claude, Cursor, Copilot, OpenCode, Codex), tracks the
install in a small ledger, and - if the preset carries `rules` - writes
guidance into the agent's guidance file the same way skill guidance is
written.

## The `mcp.yml` / `mcp.yaml` format

A repository may declare MCP server presets in an `mcp.yml` (or `mcp.yaml`)
file:

- at the repository root - these presets have no group, and
- inside any skill-group directory - the directory name becomes the
  preset's group.

If a directory has both `mcp.yml` and `mcp.yaml`, `mcp.yml` is read and
`mcp.yaml` is ignored entirely, even if `mcp.yml` fails to parse (this is a
precedence rule, not a fallback). A file that fails to parse is skipped with
a warning; it never fails the rest of the sync.

Schema:

```yaml
version: 1
servers:
  - name: <string>            # required
    type: stdio | http | sse  # required
    url: <string>             # required for http/sse
    headers:                  # optional, http/sse
      <header-name>: <value>
    command: <string>         # required for stdio
    args: [<string>, ...]     # optional, stdio
    env:                      # optional, stdio
      <VAR_NAME>: <value>
    rules: <string>           # optional guidance body
```

`stdio` requires `command`; `http` and `sse` require `url`. A server missing
the field its transport needs fails validation for the whole file.

### Example: repository root

```yaml
# mcp.yml at the repository root
version: 1
servers:
  - name: docs-http
    type: http
    url: "https://{host}/mcp"
    headers:
      Authorization: "Bearer {token}"
    rules: |
      Prefer the docs-http MCP for {host} lookups.
      Cite the source path for every answer.
  - name: local-fs
    type: stdio
    command: npx
    args: ["-y", "@acme/fs", "--root", "{root}"]
    env:
      FS_TOKEN: "{token}"
```

### Example: inside a skill group

```yaml
# tooling/mcp.yml -- group "tooling"
version: 1
servers:
  - name: tooling-sse
    type: sse
    url: "https://{host}/tooling/sse"
    headers:
      X-Api-Key: "{api_key}"
```

## Parameters

A server definition may reference `{name}` placeholders in `url`, header
values, `command`, `args`, `env` values, and `rules`. Parameters are **not**
declared anywhere - they are discovered by scanning every one of those
fields for `{[A-Za-z0-9_]+}` and collecting the distinct names. The same
name used in more than one field is still a single parameter.

Placeholder syntax is validated separately: an unclosed `{`, an empty `{}`,
or a name containing a character outside `[A-Za-z0-9_]` is rejected, with
the offending position reported.

At install time, every parameter is presented for a value (plain text; no
typed or secret fields exist yet). The rendering step substitutes each
`{name}` with its value across all of the fields listed above, including
`rules`. Rendering fails if any referenced parameter has no value.

Example: the `docs-http` server above has two parameters, `host` and
`token` (`host` appears in both `url` and `rules`; it still counts once).

## Install, update, and remove

### Install

Installing a preset for one agent:

1. Renders the parameter values into the definition.
2. Allocates an instance name: the server's `name`, snake_cased, with a
   `_<n>` suffix. Installing the same preset again produces a new instance
   (`github_1`, then `github_2`, and so on). If a name is already taken by a
   server SkillKeeper does not own, the counter skips it - an existing,
   unmanaged entry in the native config is never overwritten.
3. Writes the rendered definition into the agent's native MCP config file.
4. If the definition carries `rules`, renders and writes them into the
   agent's guidance file as a marked block (see "Rules" below).
5. Records the instance in `.skmcp.yml` and its raw parameter values in
   `.skmcp.params.yml`.
6. On the first MCP install into a project, ensures the project's
   `.gitignore` excludes both parameter files.

### Update

An installed instance can be updated when the current source definition's
content hash differs from the hash recorded at install time (see "Update
detection" below). Updating an instance:

1. Computes the new definition's parameters and compares them against the
   values already on file for that instance. Any newly-required parameter
   that has no stored value is **missing**.
2. If any parameter is missing, its value must be supplied before the
   update proceeds; closing out of that prompt without supplying every
   missing value aborts the update - nothing changes.
3. Removes the old instance and reinstalls the new definition under the
   **same** instance name, using the merged parameter values (existing
   values kept, missing ones now filled in).
4. Refreshes the recorded hash in `.skmcp.yml`.

Updating a repository preset that fans out to multiple installed instances
(different projects, agents, or both) updates every instance whose hash is
stale.

### Remove

Removing an instance reverses install: the native server entry is dropped,
its guidance block (if any) is removed by its marker key, and its entries
are dropped from both `.skmcp.yml` and `.skmcp.params.yml`. Removal is
safe to call even when one side is already gone (missing native server,
guidance block, or ledger entry).

### Update detection (hashing)

Each definition is hashed for identity comparison: a deterministic JSON
serialization of every field except `name` (so renaming a server in
`mcp.yml` is not a content change) with all object keys sorted recursively
(so key order in `headers`/`env` never affects the hash). The hash is
`sha256:<hex digest>`. Parameter **values** are never part of the hash -
they live only in `.skmcp.params.yml` - so filling in or changing a
parameter value is not, by itself, an "update."

## Tracking files

Two files, kept per agent and scope, record what SkillKeeper has installed:

- **`.skmcp.yml`** - the install ledger. One entry per installed instance:

  ```yaml
  schema: 1
  servers:
    - remote: git@github.com:acme/mcps.git   # omitted for manual presets
      group: tooling                          # omitted when at the repo root
      local: <presetId>                       # present only for manual presets
      source: docs-http                       # server name in mcp.yml/preset
      name: docs_http_1                       # assigned instance name
      hash: sha256:...                        # hash of the raw def at install
  ```

  The ledger identifies a preset by **reference**, not by a generated
  install ID: `(remote, group, source)` for a repo preset, `(local,
  source)` for a manual one. This is what lets update matching survive a
  reinstall and lets the same file double as the ownership record - it is
  the only place that says which native config entries SkillKeeper owns, so
  updates and removals act on exact instance names instead of touching
  anything unrecognized.

- **`.skmcp.params.yml`** - the sibling parameter-values file, keyed by
  instance name:

  ```yaml
  docs_http_1:
    host: mcp.example.com
    token: sk-...
  ```

  This file holds raw secrets and is never meant to be committed. The first
  MCP install into a project appends both `.skmcp.params.yml` and
  `.skmcp.params.yaml` to the project's `.gitignore` (creating the file if
  it does not exist, or appending only the lines that are missing under a
  `# SkillKeeper MCP parameter values` comment).

Both files live at the root of the agent's skills destination for the
relevant scope - the same root the skills engine already resolves for that
agent:

| agent    | project scope                              | global scope                          |
|----------|---------------------------------------------|----------------------------------------|
| claude   | `<project>/.claude/skills/`                 | `~/.claude/skills/`                    |
| cursor   | `<project>/.cursor/skills/`                 | `~/.cursor/skills/`                    |
| copilot  | `<project>/.github/copilot/skills/`         | `~/.config/github-copilot/skills/`     |
| opencode | `<project>/.opencode/skills/`               | `~/.config/opencode/skills/`           |
| codex    | (not used for MCP)                          | `~/.codex/skills/`                     |

Codex MCP installs always use the global location, regardless of which
project the install was started from (see "Codex" below).

## Per-agent native destinations

Each agent has its own native MCP config file and its own supported
transports:

| agent    | destination                    | scope   | transports      | container key |
|----------|---------------------------------|---------|------------------|----------------|
| claude   | `<project>/.mcp.json`          | project | stdio, http, sse | `mcpServers`   |
| cursor   | `<project>/.cursor/mcp.json`   | project | stdio, http, sse | `mcpServers`   |
| copilot  | `<project>/.vscode/mcp.json`   | project | stdio, http, sse | `servers`      |
| opencode | `<project>/opencode.json`      | project | stdio, http, sse | `mcp`          |
| codex    | `~/.codex/config.toml`         | global  | stdio only       | `mcp_servers`  |

Writers only touch their own container key and the server entries they own;
other keys and other servers already in the file are preserved. Output key
order is sorted, so re-writing the same content is a no-op diff.

Codex differs from the other four agents in two ways:

- **Global scope**: an MCP install for Codex always writes to
  `~/.codex/config.toml`, `~/.codex/skills/.skmcp.yml`, and
  `~/.codex/skills/.skmcp.params.yml` - never into the project - regardless
  of which project the install was started from. This is intentional and
  applies to the guidance target too (`~/AGENTS.md`): Codex has only a single
  global MCP config, so a Codex MCP server is shared across every project.
  Keeping its ledger, parameter values, instance-name allocation, and rules
  global is what keeps that one config coherent (for example, it lets
  instance names stay unique in the single `config.toml`). Note this differs
  from Codex *skill* guidance, which is project-scoped (`<project>/AGENTS.md`)
  because skills are per-project files - MCP servers are not.
- **stdio only**: Codex's native config cannot express `http` or `sse`
  servers. Installing a non-stdio preset for Codex is skipped rather than
  attempted, and is reported back as a skipped install.

The Codex writer round-trips `~/.codex/config.toml` through a TOML
parser/serializer. That preserves table structure and values but does
**not** preserve hand-written comments or formatting in the file - a
`config.toml` with comments loses them the first time SkillKeeper edits it.

opencode's native shape differs from the other JSON-based agents: a stdio
server becomes a `local` entry whose `command` array is the command
followed by its args, with `env` under the key `environment`; an http/sse
server becomes a `remote` entry (both transports use the same shape, since
opencode does not distinguish them at this level).

## Rules (guidance)

A preset's `rules` field, if present, is installed into the target agent's
guidance file using the same mechanism as skill guidance: a marked block

```
<!-- SKILLKEEPER_START: <key> -->
... rendered rules body ...
<!-- SKILLKEEPER_END: <key> -->
```

where `<key>` is built from the preset's identity (its source repository
remote, or `local:<presetId>` for a manual preset) and the installed
instance name, so the block can be found and replaced or removed later even
if the source preset changes or disappears. The rules body is rendered
(parameters substituted) before being written, and any literal
`SKILLKEEPER_START`/`SKILLKEEPER_END` marker line inside the body is
stripped first, so it cannot be mistaken for a block boundary.

Guidance files are the same ones skills write to per agent: `CLAUDE.md` (or
`.claude/CLAUDE.md`) for Claude, `AGENTS.md` for Codex and OpenCode,
`.github/copilot-instructions.md` for Copilot, and `.cursorrules` (or
`.cursor/rules/skillkeeper.mdc`) for Cursor. For Codex specifically, since
its MCP installs are global, its guidance target is `~/AGENTS.md`, not a
project file.

Removing an instance removes exactly its own marked block; other
SkillKeeper-owned blocks in the same guidance file (from skills or other
MCP instances) are left untouched.
