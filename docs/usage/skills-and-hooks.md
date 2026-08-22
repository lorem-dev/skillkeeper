# Skills and Hooks

See also: [Repositories](repositories.md) (where skills come from),
[Projects](projects.md) (where skills get installed), and
[MCP Servers](mcp.md) (a parallel subsystem that reuses the same guidance
mechanism).

## What is a skill?

A skill is a directory that contains a `SKILL.md` file plus any supporting
files. `SKILL.md` carries YAML frontmatter (name, optional version, optional
description, optional license, optional declared executables, optional
declared hook names, optional declared skill dependencies) and a Markdown body
for human documentation.

Only `name` is required. Fields SkillKeeper does not know -- another agent's
own keys, say -- are ignored, and a known field written in another shape
(`version: 1.0` as a number, a lone `executables` entry with no list) is read
as intended rather than costing the skill. A known field that cannot be read
at all is dropped with a warning; the skill still installs without it. A
`HOOK.md` is stricter: its `target` and `strategy` must be well formed, since
they decide where and how the hook edits an agent's configuration.

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

Skills may be organized in a namespace (group) nested up to three levels
deep:

```
my-group/
  my-skill/
    SKILL.md
```

```
platform/
  lint/
    rust/
      clippy-skill/
        SKILL.md
```

Group depth is at most three levels. Deeper nesting not declared in the
repository config yields an unresolved-path warning, not a silently guessed
install. The warning reads exactly:

```
Unresolved SKILL.md at "<path>": nesting is deeper than 3 group levels; declare it in skillkeeper.repo.yaml to install it.
```

## Skill dependencies

A skill may declare other skills of its own repository that it needs:

```yaml
---
name: brainstorming
skillkeeper:
  requires:
    - superpowers/using-superpowers
    - writing-plans
---
```

Two spellings are read: the namespaced `skillkeeper.requires` above, and a flat
top-level `requires`. When both are present the namespaced list wins entirely
and the flat one is ignored -- including when the namespaced list is empty,
which is how an author says "this skill has no dependencies".

A reference is an absolute skill path within the same repository:
`group/sub/name`, or bare `name` for an ungrouped skill. Cross-repository
dependencies are not supported.

A reference names the skill's **resolved identity**, not its directory path. If
`skillkeeper.repo.yaml` renames a skill or overrides its group, references must
use the resulting group and name -- the identity the skill tree shows -- not the
on-disk layout. `repo lint`'s `SK001` is the safety net for getting this wrong.

### Strictness

The asymmetry between the two spellings is deliberate:

- `skillkeeper.requires` is validated strictly. A scalar where the list
  belongs, a non-string entry, or an invalid reference means the skill does not
  resolve at all. So does a self-reference by an ungrouped skill, which is the
  only self-reference this check can see: the group comes from the directory
  layout rather than the frontmatter, so a grouped skill naming its own path is
  indistinguishable here from one naming a neighbour. It is caught afterwards,
  once the group is known, as a cycle of one (see below), and the skill
  resolves.
- Flat `requires` is lenient. A bad entry is dropped with a warning and the
  skill still installs.

A reference with no skill behind it costs the declaring skill nothing either
way: the skill resolves and installs, the repository gets a warning, `repo lint`
reports `SK001`, and the desktop app marks the skill.

Cycles are reported, not blocking. `repo lint` treats a cycle as an error
(`SK002`) and the resolver warns, but selection and installation work -- the
closure over a cycle is well defined. The message names the members without an
arrow chain: the detector returns strongly connected components rather than
traversal-ordered cycles, so an arrow chain would imply edges that may not
exist.

A skill that requires itself is a cycle of length one and is reported the same
way, under `SK002`, with a message naming that one skill:

```
Dependency cycle: skill "g/a" requires itself.
```

### Install, update, and uninstall

Install installs the transitive dependency closure, for the same agents and
scope as the named skill. A closure member already installed for that target is
reported as already installed and left as it is.

Update updates the skill's dependencies too, and installs any the new version
newly declares, for the same agents and scope as the dependent. It stays inside
the skill's own repository: a same-named skill installed from a different
repository is left alone.

Uninstall never cascades. It removes what was named, then reports every
still-installed skill it broke. A dependency counts as satisfied for a
dependent only at the dependent's own target, so removing a skill for one agent
does not warn about a dependent installed only for another. Breakage that
predates the command is not reported here; `repo lint` and the desktop marker
cover that.

See [`repo lint`](cli.md#repo-lint) for the full list of dependency
diagnostics.

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

A declared `group` (in `defaults.group` or a per-skill entry) is validated: at
most three segments; neither the whole value nor any single segment may be
empty; no `.` or `..` segment; no backslash; and no leading or trailing
whitespace in a segment. An invalid one raises the same `RepoConfigError`,
naming the field.

### Scheme 1 - flat layout

`<SKILL_NAME>/SKILL.md` at the root of the repository. No group. Hooks live
under `<SKILL_NAME>/hooks/`.

### Scheme 2 - grouped layout

`<SKILL_GROUP>/<SKILL_NAME>/SKILL.md`, where `<SKILL_GROUP>` may itself be
nested up to three levels deep (for example
`g1/g2/g3/<SKILL_NAME>/SKILL.md`). Group depth is at most three levels.
Hooks live under `<SKILL_GROUP>/<SKILL_NAME>/hooks/`.

Schemes 1 and 2 are auto-detected by scanning for `SKILL.md` files. The scan
does not stop at the depth limit -- it has to look deeper in order to report
what it finds there -- so a `SKILL.md` more than four directory levels down is
located and then reported as an unresolved path, rather than being missed
silently or installed under a guessed group.

The scan skips two families of directory outright, resolving nothing from them
and raising no warning: **hidden** directories (any name starting with `.`) and
dependency or build trees (`node_modules`, `vendor`, `target`, `dist`). Hidden
directories are where every agent keeps its *installed* skills
(`.claude/skills/`, `.codex/skills/`, `.cursor/skills/`, `.opencode/skills/`,
`.github/copilot/skills/`), so a repository that itself uses SkillKeeper holds
skills it consumes rather than publishes; treating those as candidates reported a
nesting warning for perfectly normal projects. An explicit `path` in
`skillkeeper.repo.yaml` still reaches a skipped directory, which is the way to
publish a skill from one deliberately.

All three schemes have worked examples in the
[skillkeeper-test-repo](https://github.com/lorem-dev/skillkeeper-test-repo)
fixture repository: a flat skill at
[`minimal-skill/SKILL.md`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/minimal-skill/SKILL.md),
a grouped one at
[`tooling/lint-skill/SKILL.md`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/tooling/lint-skill/SKILL.md),
two more deeply nested ones at
[`platform/lint/style-skill/SKILL.md`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/platform/lint/style-skill/SKILL.md)
(two group levels) and
[`platform/lint/rust/clippy-skill/SKILL.md`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/platform/lint/rust/clippy-skill/SKILL.md)
(three group levels, the deepest that resolves),
an inert scheme-3 sample at
[`skillkeeper.repo.yaml.example`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/skillkeeper.repo.yaml.example),
and a too-deeply-nested skill at
[`deep-nesting/l2/l3/l4/too-deep-skill/SKILL.md`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/deep-nesting/l2/l3/l4/too-deep-skill/SKILL.md)
that must not resolve.

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

Both hook layouts are shown in the fixture repository:
[`json-hooks-skill/hooks/pre-tool-use/HOOK.md`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/json-hooks-skill/hooks/pre-tool-use/HOOK.md)
is a named hook directory declaring `json-merge` with a `keyPath`, and
[`text-hook-skill/hooks/HOOK.md`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/text-hook-skill/hooks/HOOK.md)
is the single-hook layout declaring `delimited-text`.

### Per-agent skills, hooks, and guidance

| agent    | skills root (project)                 | skills root (global)               | hook strategy -> target file                                                    | guidance file |
|----------|-----------------------------------------|-------------------------------------|-----------------------------------------------------------------------------------|----------------|
| claude   | `<project>/.claude/skills/`             | `~/.claude/skills/`                 | json-merge -> `.claude/settings.json`                                             | `CLAUDE.md` at the base, or `.claude/CLAUDE.md` if no top-level file exists |
| codex    | `<project>/.codex/skills/`              | `~/.codex/skills/`                  | json-merge -> `.codex/settings.json`                                              | `AGENTS.md` at the base |
| copilot  | `<project>/.github/copilot/skills/`     | `~/.config/github-copilot/skills/`  | json-merge -> `.github/copilot/hooks.json` (project) / `~/.config/github-copilot/hooks.json` (global) | `.github/copilot-instructions.md` at the base |
| cursor   | `<project>/.cursor/skills/`             | `~/.cursor/skills/`                 | json-merge -> `.cursor/settings.json`                                             | `.cursorrules` at the base, or `.cursor/rules/skillkeeper.mdc` if no legacy file exists |
| opencode | `<project>/.opencode/skills/`           | `~/.config/opencode/skills/`        | delimited-text (`#`) -> `<project>/.opencode/opencode.json` (project) / `~/.config/opencode/opencode.json` (global) | `AGENTS.md` at the base |

"Base" is the project directory for project scope, or the user's home
directory for global scope. Claude is the reference adapter (its path and
hook logic is the model the other four follow); each of the other four
adapters isolates its path and hook choices to its own module, so confirming
an agent's real on-disk layout only ever changes that one module, never its
callers.

## Skill guidance (GUIDE.md / RULES.md)

A skill may optionally ship a `GUIDE.md` or `RULES.md` file containing
guidance for the agent that installs it. `GUIDE.md` takes precedence when
both files are present. If neither exists, no guidance is installed. The
fixture repository's
[`documented-skill`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/documented-skill/SKILL.md)
ships both files, so it installs only its `GUIDE.md`.

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
re-consented, its hooks) to restore the recorded state, then removes the
`extraneous` files, so the install verifies clean afterwards. Every deleted path
is reported. Verify is read-only; repair mutates and is always explicit.

Two things bound that deletion. A skill's installed directory is named after the
skill alone, so two skills with the same name from different groups or
repositories share one directory; files recorded by any other install under the
same root are protected. And a recorded path that could resolve outside the
destination root (a skill whose declared name is `..`, say) disables pruning for
that install rather than being followed.

---

## Encapsulation

Skill or hook content that itself contains SkillKeeper delimiter comments or
a `_skillkeeper` marker has those tokens encapsulated on install so they
cannot be mistaken for managed regions. The encapsulation is reversed on read
for display.
