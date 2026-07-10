# Skills and Hooks

See also: [Repositories](repositories.md) (where skills come from),
[Projects](projects.md) (where skills get installed), and
[MCP Servers](mcp.md) (a parallel subsystem that reuses the same guidance
mechanism).

## What is a skill?

A skill is a directory that contains a `SKILL.md` file plus any supporting
files. `SKILL.md` carries YAML frontmatter (name, optional version, optional
description, optional license, optional declared executables, optional
declared hook names) and a Markdown body for human documentation.

```
my-skill/
  SKILL.md          frontmatter + documentation
  run.sh            supporting file (example)
  helpers/          supporting subdirectory (example)
  GUIDE.md          optional guidance for the installing agent (see below)
  hooks/            reserved - hook files live here
    HOOK.md
    hook-file.sh
```

The `hooks/` subdirectory is reserved: its contents belong to the skill's
hooks and are never included in the skill body. Running a skill is the
agent's job; SkillKeeper only installs files and edits config regions.

## Skill groups

Skills may be organized in a one-level namespace (group):

```
my-group/
  my-skill/
    SKILL.md
```

Group depth is exactly one. Deeper nesting not declared in the repository
config yields an unresolved-path warning, not a silently guessed install.

## Skill resolution schemes

SkillKeeper discovers skills in a cloned repository working tree using one of
three schemes, applied in this order:

### Scheme 3 - repository config (authoritative)

If `skillkeeper.repo.yaml` exists at the repository root, it is authoritative
and all auto-detection is skipped. The file declares explicit skill paths and
optional metadata overrides:

```yaml
version: 1
defaults:
  group: optional-default-group
skills:
  - path: relative/path/to/skill   # directory containing SKILL.md
    name: optional-name-override
    group: optional-group-override
include: ["glob", ...]             # optional allowlist of skill dirs
exclude: ["glob", ...]             # optional denylist
```

A malformed or schema-invalid `skillkeeper.repo.yaml` raises a
`RepoConfigError` naming the first offending field; the caller decides how to
surface that (the desktop app skips the repository for that operation rather
than crash).

### Scheme 1 - flat layout

`<SKILL_NAME>/SKILL.md` at the root of the repository. No group. Hooks live
under `<SKILL_NAME>/hooks/`.

### Scheme 2 - grouped layout

`<SKILL_GROUP>/<SKILL_NAME>/SKILL.md`. Group depth is exactly one. Hooks live
under `<SKILL_GROUP>/<SKILL_NAME>/hooks/`.

Schemes 1 and 2 are auto-detected by scanning up to two directory levels deep
for `SKILL.md` files; anything nested deeper produces the unresolved-path
warning mentioned above instead of a guessed install.

---

## What is a hook?

A hook is an optional unit inside a skill (`hooks/HOOK.md` plus files) that
mutates an agent's own configuration. Hooks are **privileged**: they are
never installed implicitly. Installing or updating a hook always requires a
separate, explicit confirmation distinct from installing the skill body.

In the CLI, use `--allow-hooks`:

```
skillkeeper skill install <id> --agent claude --allow-hooks
```

Without that flag, the skill body installs and hooks are skipped with a clear
notice. The desktop app requires the same explicit, separate consent before
applying a hook.

## Hook apply strategies

Because agents store configuration in different file formats, hooks use one
of three strategies declared in `HOOK.md`:

### delimited-text

For comment-capable files. SkillKeeper inserts an owned, delimited region
using the appropriate comment token:

```
# >>> skillkeeper:hook group/name:hookName v1.0.0 >>>
... generated content ...
# <<< skillkeeper:hook group/name:hookName <<<
```

The delimiter line carries a stable `delimiterId` so the exact region can be
located and removed later even if surrounding content changed. Of the five
built-in agents, only OpenCode uses this strategy today (comment token `#`,
target `opencode.json`).

### json-merge

For JSON config that has no comment syntax. SkillKeeper merges its entries
into the correct array (by a dotted `keyPath`, `hooks` by default) and tags
each inserted node with a reserved ownership marker:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "_skillkeeper": { "id": "...", "label": "group/name:hookName" },
        "matcher": "...",
        "hooks": [...]
      }
    ]
  }
}
```

The `_skillkeeper` marker plays the same role as a delimiter comment: it
makes the managed entry visible in-file and lets uninstall remove exactly the
owned node by its `markerId`. Existing user-managed hook entries are
preserved, and key order in the rewritten JSON is always sorted for a stable
diff. Claude, Codex, Copilot, and Cursor all use this strategy.

### file

Hook-owned standalone files, tracked as `ManagedFile` entries flagged as
hook-owned. Removed by path on uninstall, like any other managed file.

### Per-agent skills, hooks, and guidance

| agent    | skills root (project)                 | skills root (global)               | hook strategy -> target file                                                    | guidance file |
|----------|-----------------------------------------|-------------------------------------|-----------------------------------------------------------------------------------|----------------|
| claude   | `<project>/.claude/skills/`             | `~/.claude/skills/`                 | json-merge -> `.claude/settings.json`                                             | `CLAUDE.md` at the base, or `.claude/CLAUDE.md` if no top-level file exists |
| codex    | `<project>/.codex/skills/`              | `~/.codex/skills/`                  | json-merge -> `.codex/settings.json`                                              | `AGENTS.md` at the base |
| copilot  | `<project>/.github/copilot/skills/`     | `~/.config/github-copilot/skills/`  | json-merge -> `.github/copilot/hooks.json` (project) / `~/.config/github-copilot/hooks.json` (global) | `.github/copilot-instructions.md` at the base |
| cursor   | `<project>/.cursor/skills/`             | `~/.cursor/skills/`                 | json-merge -> `.cursor/settings.json`                                             | `.cursorrules` at the base, or `.cursor/rules/skillkeeper.mdc` if no legacy file exists |
| opencode | `<project>/.opencode/skills/`           | `~/.config/opencode/skills/`        | delimited-text (`#`) -> `opencode.json`                                          | `AGENTS.md` at the base |

"Base" is the project directory for project scope, or the user's home
directory for global scope. Claude is the reference adapter (its path and
hook logic is the model the other four follow); each of the other four
adapters isolates its path and hook choices to its own module, so confirming
an agent's real on-disk layout only ever changes that one module, never its
callers.

## Skill guidance (GUIDE.md / RULES.md)

A skill may optionally ship a `GUIDE.md` or `RULES.md` file containing
guidance for the agent that installs it. `GUIDE.md` takes precedence when
both files are present. If neither exists, no guidance is installed.

On install, the guide body is written as a marked block into each target
agent's guidance file (from the table above). The block uses delimiters:

```
<!-- SKILLKEEPER_START: <remote>; <id> -->
... guide body ...
<!-- SKILLKEEPER_END: <remote>; <id> -->
```

Where `<remote>` is the skill's source repository remote URL and `<id>` is
the skill identifier (`group/name`, or just `name` for ungrouped skills).
This is the same block mechanism [MCP presets](mcp.md) use for their `rules`
field, keyed the same way but built from a different identity.

### Update and uninstall behavior

When a skill is updated, its guidance block is replaced in place, preserving
its position in the guidance file. If a reinstall drops the skill's
`GUIDE.md`/`RULES.md` (the source no longer ships one), the now-stale block
is removed instead.

When a skill is uninstalled, its marked block is removed by its delimiters
(identified by remote URL and skill ID), even if the source guide no longer
exists in the skill.

When multiple agents share a guidance file, or multiple skills share it, a
block is removed only when no remaining installed skill still claims it -
removing one skill's block never disturbs another skill's block in the same
file. If removing the file's only remaining block empties a file SkillKeeper
created, the file itself is deleted rather than left behind as an empty file.

---

## Content hashing

Every managed file is hashed with plain lowercase-hex SHA-256 (`sha256`). A
skill's **content hash** is a single SHA-256 over its sorted,
`<skill-relative-path>\0<sha256>` lines - stable regardless of install
location, and computed the same way whether the source is a working-tree
skill (`resolvedContentHash`), an installed manifest (`manifestContentHash`),
or a freshly re-hashed directory found on disk. The `.skid.yml` identity
file (below) is always excluded from this hash, by its basename, so writing
or rewriting it never changes the hash it records. This is the hash compared
for update detection (see [Repositories](repositories.md#update-detection))
and used during reconciliation (below).

## The `.skid.yml` identity file

Every skill install writes a `.skid.yml` file at the root of its installed
directory - SkillKeeper's own authoritative record of where the skill came
from:

```yaml
# SkillKeeper identity file. Generated on install; do not edit.
schema: 1
remote: git@github.com:acme/team-skills.git   # omitted for local-path installs
name: my-skill
group: my-group                                # omitted when ungrouped
version: <content hash, sha256 hex>
```

Any `.skid.yml` present in the skill's *source* is dropped before its files
are copied; `installSkill` always writes its own copy afterward, so an
installed skill's identity file is never a stale copy carried over from the
repository. It is tracked as a normal `ManagedFile` in the `InstallManifest`
(so uninstall removes it and verify checks it), and it is excluded from the
skill's own content hash.

`.skid.yml` matters because it survives even when SkillKeeper's local state
store does not: if the skill directory is copied into a project via Git, or
the app's state file is lost, `.skid.yml` still identifies the skill's name,
group, and source remote, and records the content hash it was installed
with. Reconciliation (below) reads it back to re-identify a skill purely from
what is on disk.

## Install, update, and uninstall

### Skill body install

1. Resolve the skill from the repository working tree.
2. Ask the agent adapter for the destination root.
3. Copy skill body files (excluding `hooks/` and any source `.skid.yml`),
   applying `+x` to files declared executable in the manifest or matched by
   the configured executable globs, and hashing each copied file.
4. Compute the skill's content hash over those files (skill-relative paths,
   `.skid.yml` excluded).
5. Write the skill's own `.skid.yml`, using that content hash as `version`.
6. Record everything - body files, the identity file, and (if applied) hook
   edits - as an `InstallManifest`.

### Hook install (privileged)

Runs only when `--allow-hooks` is passed (CLI) or explicit desktop consent is
given. Applies the hook's edit strategy and records the result as a
`ManagedHookEdit` in the `InstallManifest`.

### Uninstall

Uninstall is the precise reverse of install: every recorded `ManagedFile` is
removed (pruning now-empty ancestor directories up to the destination root),
and every recorded `ManagedHookEdit` is removed by its own kind - a delimited
region by `delimiterId`, a JSON node by `markerId`, a hook-owned file by
path. Nothing not recorded in the manifest is ever touched, so external
skills (below) and unrelated hook entries in the same file are untouched.

---

## Reconciliation

A project's skill directories are ordinary files on disk, so they can drift
from SkillKeeper's own install records: a `git pull` can add or remove a
skill directory, files can be hand-edited, or a skill can be installed by
some other means entirely. Reconciliation re-derives the install list from
what is actually on disk, for every tracked project and every agent's skills
root:

- A directory counts as a skill when it carries a `SKILL.md` or a
  `.skid.yml`. Its files are re-hashed and its content hash recomputed.
- Its `.skid.yml`, if present, supplies the skill's name, group, and source
  remote; a directory with no `.skid.yml` but a prior manifest keeps that
  manifest's remembered remote.
- The remote is matched against every tracked repository's URL after
  **normalizing** both (dropping transport, user, port, a trailing `.git`,
  and letter case) - so re-adding the same repository under a different
  clone-URL shape still re-adopts skills installed under its earlier remote.
- A skill whose remote does not match any tracked repository keeps its
  previous repository id (the repository was removed, but its skills remain
  installed and working), or, the first time reconciliation sees the
  directory at all, is recorded with an empty-string repository id - an
  **unmanaged** skill: present in the project, safe to keep or remove, but
  never source of an "update available" badge because it has no tracked
  repository to compare against.

Projects whose folder does not currently exist are left completely
untouched: reconciliation neither scans nor prunes their recorded installs,
so a temporarily unreachable project (an unmounted drive, a folder mid-move)
never loses its history. See [Projects](projects.md#reconciliation) for when
reconciliation runs.

Each `AgentAdapter` also implements a lower-level `discoverInstalled`, which
simply lists the skill-shaped directories under its skills root without any
of the identity or hash logic above; reconciliation is the higher-level
process the desktop app actually runs to build its adopted/unmanaged skill
view.

## Verification and repair

`verify` recomputes hashes for every `ManagedFile` and `ManagedHookEdit`
region and compares them to the manifest, reporting per file: `ok`,
`modified`, `missing`, or `extraneous` (a file present in a managed
directory that is not recorded in the manifest).

`repair` reinstalls the affected skill (and, only if originally installed and
re-consented, its hooks) to restore the recorded state. Verify is read-only;
repair mutates and is always explicit.

---

## Encapsulation

Skill or hook content that itself contains SkillKeeper delimiter comments or
a `_skillkeeper` marker has those tokens encapsulated on install so they
cannot be mistaken for managed regions. The encapsulation is reversed on read
for display.
