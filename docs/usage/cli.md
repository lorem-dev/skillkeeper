# CLI Reference

The SkillKeeper CLI is a Rust binary (`skillkeeper`) built with
[clap](https://github.com/clap-rs/clap). Output is English-only by design (a
stable surface for scripting); localization applies to the desktop app only.
Commands exit with a non-zero code on failure.

A startup warning is printed when `config.yaml` has any invalid section.

---

## skillkeeper repo

Manage skill repositories.

### repo add

```
skillkeeper repo add <url> [local-path]
```

Clone a Git repository and register it as a skill source. Supports SSH and
HTTPS transports.

- `<url>` - the remote to clone.
- `[local-path]` - optional clone destination. When omitted, the repository is
  cloned into a per-repository directory under the app's repositories folder
  (the same location the desktop app uses).
- `--name <name>` - human-readable name (defaults to the repository name derived
  from the URL).
- `--lfs` / `--no-lfs` - force Git LFS on or off. By default LFS is enabled when
  `git-lfs` is installed and off otherwise.

### repo remove

```
skillkeeper repo remove <id>
```

Remove a repository from the registry. Does not delete the local clone.

### repo list

```
skillkeeper repo list
```

List all registered repositories with their IDs, URLs, and last-fetched time.

### repo update

```
skillkeeper repo update [--all | <id>]
```

Fetch from the remote and report update availability. Does not modify any
installed skills.

- `--all` - update all registered repositories.
- `<id>` - update a specific repository.

---

## skillkeeper skill

Manage skills.

Every `<id>` argument below accepts a full `group/name` (or bare `name`), or any
unique prefix of one -- Docker-container-id style: `ab` resolves to `abba` when
it is the only skill id starting with `ab`. An ambiguous prefix is rejected with
the list of matches.

### skill list

```
skillkeeper skill list
```

List all skills resolved from registered repositories, with name, version, and
source.

### skill info

```
skillkeeper skill info <id>
```

Show details for a skill: name, version, description, source repository, and
the agent targets it is currently installed for.

### skill install

```
skillkeeper skill install <id> [--agent <agent>] [--global] [--project <dir>] [--allow-hooks]
```

Install a skill for one or more agents.

- `--agent <agent>` - optional. One of `claude`, `codex`, `copilot`, `cursor`,
  `opencode`. When omitted, the skill is installed for every agent detected in
  the project directory (by its marker files); if none are detected the command
  asks you to pass `--agent`.
- `--global` - install globally (machine-wide) instead of into the current
  project.
- `--project <dir>` - project directory for project scope (default: the current
  directory). Ignored with `--global`.
- `--allow-hooks` - also install the skill's hooks. Without this flag, hooks
  are skipped and a notice is printed. Hooks are privileged; see
  [Skills and Hooks](skills-and-hooks.md).

### skill uninstall

```
skillkeeper skill uninstall <id> [--agent <agent>]
```

Uninstall a skill. Removes all `ManagedFile` entries recorded in the manifest
and all `ManagedHookEdit` regions (by `delimiterId` or `markerId`). Does not
touch files or regions not owned by this installation.

- `--agent <agent>` - limit to one agent; otherwise every agent the skill is
  installed for is removed.

### skill update

```
skillkeeper skill update <id> [--agent <agent>] [--project <dir>] [--allow-hooks]
```

Update a skill to the latest version from its source repository (by default for
every agent target where it is installed).

- `--agent <agent>` - limit the update to one agent.
- `--project <dir>` - project directory for project-scope installs (default: the
  recorded path, or the current directory).
- `--allow-hooks` - re-apply the skill's hooks during the update (requires the
  same explicit consent as install).

### skill verify

```
skillkeeper skill verify <id> [--agent <agent>]
```

Recompute hashes for every managed file and hook edit region and compare them
to the manifest. Reports per file: `ok`, `modified`, `missing`, or
`extraneous`. Read-only; does not modify anything.

- `--agent <agent>` - limit verification to one agent.

### skill repair

```
skillkeeper skill repair <id> [--agent <agent>] [--project <dir>] [--allow-hooks]
```

Reinstall a skill's files (and hooks, only if originally installed and
re-consented) to restore the state recorded in the manifest. Mutates the
filesystem; always explicit.

- `--agent <agent>` - limit the repair to one agent.
- `--project <dir>` - project directory for project-scope installs (default: the
  recorded path, or the current directory).
- `--allow-hooks` - re-apply the skill's hooks during the repair (requires
  consent).

---

## skillkeeper project

Manage tracked projects.

### project add

```
skillkeeper project add <path> [--name <name>]
```

Register a directory as a tracked project. Use `.` for the current directory.

- `--name <name>` - human-readable name (defaults to the folder's name).

### project remove

```
skillkeeper project remove <id>
```

Remove a tracked project. Does not uninstall any skills.

### project list

```
skillkeeper project list
```

List all tracked projects with their IDs and paths.

---

## skillkeeper config

Manage the SkillKeeper configuration.

### config validate

```
skillkeeper config validate
```

Validate all sections of `config.yaml`. Prints per-section results and exits
non-zero if any section is invalid.

### config edit

```
skillkeeper config edit
```

Open `config.yaml` in the configured editor (from `general.editor` in
`config.yaml`, defaulting to `code`).

### config path

```
skillkeeper config path
```

Print the absolute path to `config.yaml`.

---

## skillkeeper check

```
skillkeeper check [--all]
```

Check for available updates across repositories and installed skills. Read-only;
does not modify installs.

- `--all` - accepted for compatibility; `check` always inspects every tracked
  repository regardless of this flag.

Output lists per-repository and per-skill update availability.

---

## skillkeeper mcp

Manage MCP server presets (see [MCP Servers](mcp.md) for the preset format and
behavior). Preset names accept the same unique-prefix shorthand as skill ids.

### mcp list

```
skillkeeper mcp list
```

List the available MCP presets: those defined manually in `config.yaml` plus
those discovered in tracked repositories.

### mcp install

```
skillkeeper mcp install <name> [--agent <agent>]... [--param <name=value>]... [--project <dir>]
```

Install an MCP preset for one or more agents.

- `--agent <agent>` - the agent(s) to install for; repeatable or
  comma-separated.
- `--param <name=value>` - repeatable; supplies values for the preset's
  `{param}` placeholders.
- `--project <dir>` - project directory (default: the current directory);
  ignored for `codex`, which is installed globally.

### mcp remove

```
skillkeeper mcp remove <instance-name> --agent <agent> [--project <dir>]
```

Remove an installed MCP instance, identified by its assigned instance name (the
native config key), for the given agent.

### mcp update

```
skillkeeper mcp update [<name>] [--agent <agent>]... [--all] [--param <name=value>]... [--project <dir>]
```

Reinstall MCP instances whose source definition changed. Limit to one preset by
name (default: all project agents), or pass `--all` to check every tracked
project and agent plus the global `codex` ledger. `--param` supplies values for
any newly required placeholders.

---

## skillkeeper version

```
skillkeeper version
```

Print the version, for example `skillkeeper 0.1.2-rc.1`. The same string is
printed by the global `-V`, `-v`, and `--version` flags (e.g.
`skillkeeper --version`).
