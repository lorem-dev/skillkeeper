# Skills and Hooks

## What is a skill?

A skill is a directory that contains a `SKILL.md` file plus any supporting
files. `SKILL.md` carries YAML frontmatter (name, optional version, optional
description, optional license, optional declared executables) and a Markdown
body for human documentation.

```
my-skill/
  SKILL.md          frontmatter + documentation
  run.sh            supporting file (example)
  helpers/          supporting subdirectory (example)
  hooks/            reserved - hook files live here
    HOOK.md
    hook-file.sh
```

The `hooks/` subdirectory is reserved: its contents belong to the skill's
hooks and are never included in the skill body. Running a skill is the agent's
job; SkillKeeper only installs files and edits config regions.

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

### Scheme 1 - flat layout

`<SKILL_NAME>/SKILL.md` at the root of the repository. No group. Hooks live
under `<SKILL_NAME>/hooks/`.

### Scheme 2 - grouped layout

`<SKILL_GROUP>/<SKILL_NAME>/SKILL.md`. Group depth is exactly one. Hooks live
under `<SKILL_GROUP>/<SKILL_NAME>/hooks/`.

---

## What is a hook?

A hook is an optional unit inside a skill (`hooks/HOOK.md` plus files) that
mutates an agent's own configuration. Hooks are **privileged**: they are never
installed implicitly. Installing or updating a hook always requires a separate,
explicit confirmation distinct from installing the skill body.

In the CLI, use `--allow-hooks`:

```
skillkeeper skill install <id> --agent claude --allow-hooks
```

Without that flag, the skill body installs and hooks are skipped with a clear
notice.

## Hook apply strategies

Because agents store configuration in different file formats, hooks use one of
three strategies declared in `HOOK.md`:

### delimited-text

For comment-capable files (shell rc, Markdown, YAML, TOML). SkillKeeper
inserts an owned, delimited region using the appropriate comment token (`#`,
`//`, or `<!-- -->`):

```
# >>> skillkeeper:hook group/name:hookName v1.0.0 >>>
... generated content ...
# <<< skillkeeper:hook group/name:hookName <<<
```

The delimiter line carries a stable `delimiterId` so the exact region can be
located and removed later even if surrounding content changed.

### json-merge

For JSON config that has no comment syntax. This is the strategy Claude uses:
hooks are stored in `settings.json` under the `hooks` key. SkillKeeper merges
its entries into the correct event arrays and tags each inserted node with a
reserved ownership marker:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "_skillkeeper": "group/name:hookName",
        "markerId": "...",
        "matcher": "...",
        "hooks": [...]
      }
    ]
  }
}
```

The `_skillkeeper` marker plays the same role as a delimiter comment: it makes
the managed entry visible in-file and lets uninstall remove exactly the owned
node. Existing user-managed hook entries are preserved.

### file

Hook-owned standalone files, tracked as `ManagedFile` entries flagged as
hook-owned.

---

## Skill guidance (GUIDE.md / RULES.md)

A skill may optionally ship a `GUIDE.md` or `RULES.md` file containing guidance
for the agent that installs it. `GUIDE.md` takes precedence when both files are
present. If neither exists, no guidance is installed.

On install, the guide body is written as a marked block into each target agent's
guidance file. The block uses delimiters:

```
<!-- SKILLKEEPER_START: <remote>; <id> -->
... guide body ...
<!-- SKILLKEEPER_END: <remote>; <id> -->
```

Where `<remote>` is the skill's source repository remote URL and `<id>` is the
skill identifier (`group/name` or just `name` for ungrouped skills).

### Per-agent guidance files

Each agent writes its guidance blocks to the appropriate file:

- **Claude:** `CLAUDE.md` at the repository root, or `.claude/CLAUDE.md` if
  no top-level file exists.
- **Codex and OpenCode:** `AGENTS.md` at the repository root.
- **Copilot:** `.github/copilot-instructions.md`.
- **Cursor:** `.cursorrules` at the repository root, or `.cursor/rules/skillkeeper.mdc`
  if no legacy `.cursorrules` file exists.

### Update and uninstall behavior

When a skill is updated, its guidance block is replaced in place, preserving
its position in the guidance file.

When a skill is uninstalled, its marked block is removed by its delimiters
(identified by remote URL and skill ID), even if the source guide no longer
exists in the skill.

When multiple agents share a guidance file (e.g., `AGENTS.md` for Codex and
OpenCode), a block is removed only when no remaining installed skill claims it.

---

## Encapsulation

Skill or hook content that itself contains SkillKeeper delimiter comments or a
`_skillkeeper` marker has those tokens encapsulated on install so they cannot
be mistaken for managed regions. The encapsulation is reversed on read for
display.

---

## Install behavior

### Skill body install

1. Resolve the skill from the repository working tree.
2. Ask the agent adapter for the destination root.
3. Copy skill files (excluding `hooks/`), computing SHA-256 for each.
4. Apply `+x` to files declared executable in the manifest or matched by the
   configured executable globs.
5. Write an `InstallManifest` recording every file with its hash and executable
   bit.

### Hook install (privileged)

Runs only when `--allow-hooks` is passed (CLI) or explicit GUI consent is
given. Applies the hook's edit strategy and records the result as a
`ManagedHookEdit` in the `InstallManifest`.

### Uninstall

- Skill uninstall removes exactly the `ManagedFile` entries in the manifest,
  removes now-empty skill directories, and deletes the manifest.
- Hook uninstall removes each `ManagedHookEdit` by its kind: delimited regions
  by `delimiterId`, JSON nodes by `markerId`, hook-owned files by path.
- External skills (those not installed by SkillKeeper) may be removed as skill
  bodies only; SkillKeeper never touches hook regions it does not own.

---

## Verification and repair

`verify` recomputes hashes for every `ManagedFile` and `ManagedHookEdit`
region and compares them to the manifest, reporting per file: `ok`, `modified`,
`missing`, or `extraneous` (a file in a managed directory that is not
recorded).

`repair` reinstalls the affected skill (and, only if originally installed and
re-consented, its hooks) to restore the recorded state. Verify is read-only;
repair mutates and is always explicit.

---

## External skills

`discoverInstalled` lets SkillKeeper list skills present in agent locations
that have no SkillKeeper manifest. These are shown as "external" and may be
removed as skill bodies only. SkillKeeper never deletes hook regions it did
not create.
