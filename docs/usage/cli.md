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

### repo lint

```
skillkeeper repo lint [<id> | --all | --path <dir>] [--json]
```

Report everything statically wrong with a skill repository's skills: missing
dependencies, dependency cycles, unresolvable skills, and other static faults.
Reporting only -- nothing here changes what resolves or installs. This does not
check for updates; `check` does that.

Exactly one target is required, and the three are mutually exclusive:

- `<id>` - one tracked repository, by id.
- `--all` - every tracked repository, grouped by repository. A repository whose
  working tree is missing is reported on stderr and skipped; the rest still
  lint.
- `--path <dir>` - a directory that is not a tracked repository. This is the
  form a skill author uses in their own CI, before the repository is registered
  anywhere.

`--json` emits a JSON array of diagnostics instead of human output. Stdout is
always exactly one parseable array, including on a `2` exit, where it is `[]`.

Exit codes:

- `0` - no error was reported. Warnings alone do not fail, because a repository
  with warnings still installs. `--all` finding no tracked repositories also
  exits `0`, with a message saying exactly that.
- `1` - at least one error was reported among the repositories that were
  linted.
- `2` - a usage or lookup failure: no target, more than one target, an unknown
  repository id, or a named target (`<id>` or `--path <dir>`) whose working tree
  does not exist. A named target that could not be linted never prints the clean
  message, so a mistyped path in a CI gate cannot look like success.

| code | severity | condition |
|---------|----------|-----------|
| `SK001` | error | A declared dependency does not exist in the repository. |
| `SK002` | error | A dependency cycle. The message names the members. |
| `SK003` | error | `skillkeeper.requires` failed strict validation; the skill does not resolve. |
| `SK004` | error | A `SKILL.md` does not resolve for any other reason. |
| `SK005` | error | A `hooks:` entry names a hook with no readable `hooks/<name>/HOOK.md`. |
| `SK010` | warning | Dependencies declared with the flat `requires` field. |
| `SK011` | warning | Both forms present; the flat `requires` was ignored. |
| `SK012` | warning | A duplicate entry in a dependency list. |
| `SK013` | warning | An `executables:` entry names a path absent from the skill body. |
| `SK014` | warning | A manifest field was coerced, dropped, or re-quoted. |

Codes are stable and are what a script should match on; the message text is
not.

---

## skillkeeper skill

Manage skills.

Every `<id>` argument below accepts a full `group/name` (or bare `name`), or any
unique prefix of one -- Docker-container-id style: `ab` resolves to `abba` when
it is the only skill id starting with `ab`. The `group` half may itself be a
nested path up to three levels deep (`platform/lint/rust/clippy-skill`). An
ambiguous prefix is rejected with the list of matches.

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

Install a skill for one or more agents, together with its transitive
dependency closure (see
[Skill dependencies](skills-and-hooks.md#skill-dependencies)). Each dependency
is installed for the same agents and scope as the named skill, and reported as
installed as a dependency. A skill already installed for that target -- the
named one or a dependency -- prints an "already installed" line and is left as
it is. A dependency reference with no skill behind it is named on stderr; the
named skill still installs.

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

Uninstall never cascades to a skill's dependencies or dependents. It reports on
stderr every still-installed skill this call broke, per target -- a dependency
counts as satisfied for a dependent only at the dependent's own target -- and
the exit code does not change. Breakage that predates the call is `repo lint`'s
to report.

- `--agent <agent>` - limit to one agent; otherwise every agent the skill is
  installed for is removed.

### skill update

```
skillkeeper skill update <id> [--agent <agent>] [--project <dir>] [--allow-hooks]
```

Update a skill to the latest version from its source repository (by default for
every agent target where it is installed). The skill's dependencies are updated
with it, and a dependency the new version newly declares is installed, for the
same agents and scope as the dependent. Dependency resolution stays inside the
skill's own repository: a same-named skill installed from a different repository
is left alone.

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

Repair also **deletes** files it finds in the skill's installed directory that
the manifest does not record -- the ones `verify` reports as `extraneous` --
because otherwise `verify` would still fail right after a successful repair. Each
deleted path is printed. Files recorded by another skill installed into the same
directory are never touched.

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
skillkeeper mcp install <name> [--agent <agent>]... [--param <name=value>]... [--project <dir>] [--global]
```

Install an MCP preset for one or more agents.

An agent whose native config cannot express the preset's transport is skipped
with a notice rather than attempted -- Codex, for example, supports `stdio` only.
The command exits non-zero when it installed nothing at all, so a single-agent
install that was skipped reports failure, while a multi-agent install that
succeeded for at least one agent reports success.

- `--agent <agent>` - the agent(s) to install for; repeatable or
  comma-separated.
- `--param <name=value>` - repeatable; supplies values for the preset's
  `{param}` placeholders.
- `--project <dir>` - project directory (default: the current directory).
  Mutually exclusive with `--global`.
- `--global` - install for the whole user, in every project, instead of one
  project directory. Mutually exclusive with `--project`. Required for `codex`,
  whose MCP config is user-wide.

### mcp remove

```
skillkeeper mcp remove <instance-name> --agent <agent> [--project <dir>] [--global]
```

Remove an installed MCP instance, identified by its assigned instance name (the
native config key), for the given agent.

- `--project <dir>` - project directory (default: the current directory).
  Mutually exclusive with `--global`.
- `--global` - act on the user-wide installs instead of a project's. Mutually
  exclusive with `--project`.

### mcp update

```
skillkeeper mcp update [<name>] [--agent <agent>]... [--all] [--param <name=value>]... [--project <dir>] [--global]
```

Reinstall MCP instances whose source definition changed. Limit to one preset by
name (default: all project agents), or pass `--all` to check every tracked
project and agent plus every agent's global ledger. `--param` supplies values
for any newly required placeholders.

- `--project <dir>` - project directory (default: the current directory);
  ignored with `--all`. Mutually exclusive with `--global`.
- `--global` - act on the user-wide installs instead of a project's. Mutually
  exclusive with `--project` and `--all`. Required for `codex`, whose MCP config
  is user-wide: `--agent codex` at project scope is refused, the same way
  `mcp install` refuses it.

---

## skillkeeper version

```
skillkeeper version
```

Print the version, for example `skillkeeper 0.1.2-rc.1`. The same string is
printed by the global `-V`, `-v`, and `--version` flags (e.g.
`skillkeeper --version`).

---

## skillkeeper update

```
skillkeeper update
```

Print the current CLI version and the one-line install command that
reinstalls the latest release for the host platform. This prints instructions
only -- no network access, no version check against GitHub, no files changed.
It is a different command from `repo update`, `skill update`, and `mcp
update`, which check or refresh already-installed content.
