# CLI Reference

The SkillKeeper CLI is a Rust binary (`skillkeeper`) built with
[clap](https://github.com/clap-rs/clap). All output is localizable. Commands
exit with a non-zero code on failure.

A startup warning is printed when `config.yaml` has any invalid section.

---

## skillkeeper repo

Manage skill repositories.

### repo add

```
skillkeeper repo add <url>
```

Clone a Git repository and register it as a skill source. Supports SSH and
HTTPS transports. Runs preflight checks for `git` (and `git-lfs` when the
repository declares LFS).

### repo remove

```
skillkeeper repo remove <id>
```

Remove a repository from the registry and delete its local clone.

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
skillkeeper skill install <id> --agent <agent> [--global] [--allow-hooks]
```

Install a skill for the specified agent.

- `--agent <agent>` - required. One of `claude`, `codex`, `copilot`, `cursor`,
  `opencode`.
- `--global` - install globally (machine-wide) instead of into the current
  project.
- `--allow-hooks` - also install the skill's hooks. Without this flag, hooks
  are skipped and a notice is printed. Hooks are privileged; see
  [Skills and Hooks](skills-and-hooks.md).

### skill uninstall

```
skillkeeper skill uninstall <id>
```

Uninstall a skill. Removes all `ManagedFile` entries recorded in the manifest
and all `ManagedHookEdit` regions (by `delimiterId` or `markerId`). Does not
touch files or regions not owned by this installation.

### skill update

```
skillkeeper skill update <id>
```

Update a skill to the latest version from its source repository (for every
agent target where it is installed).

### skill verify

```
skillkeeper skill verify <id>
```

Recompute hashes for every managed file and hook edit region and compare them
to the manifest. Reports per file: `ok`, `modified`, `missing`, or
`extraneous`. Read-only; does not modify anything.

### skill repair

```
skillkeeper skill repair <id>
```

Reinstall a skill's files (and hooks, only if originally installed and
re-consented) to restore the state recorded in the manifest. Mutates the
filesystem; always explicit.

---

## skillkeeper project

Manage tracked projects.

### project add

```
skillkeeper project add <path>
```

Register a directory as a tracked project. Use `.` for the current directory.

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

- `--all` - check all registered repositories. Without this flag, checks the
  repositories relevant to your tracked projects.

Output lists per-repository and per-skill update availability.

---

## skillkeeper version

```
skillkeeper version
```

Print the version, for example `skillkeeper 0.1.1-rc.2`. The same string is
printed by the global `-V`, `-v`, and `--version` flags (e.g.
`skillkeeper --version`).
