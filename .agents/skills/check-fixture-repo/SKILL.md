---
name: check-fixture-repo
description: >
  Validate the examples/test-repo fixture submodule and drive the built CLI
  against it end to end -- resolution schemes, groups, hooks, guidance
  precedence, executables, MCP presets and parameters, and the verify/repair
  round-trip -- in a throwaway state directory that cannot touch the developer's
  real configuration.
---

# check-fixture-repo

The unit tests cover the domain core against an in-memory filesystem. This skill
covers the layer they cannot: the real `skillkeeper` binary, against a real Git
working tree, writing real files. It is the only check that would catch a
regression living in the wiring between the CLI, the adapters, and the
filesystem -- for example an adapter resolving the wrong destination root, or a
skill that resolves in `MemFs` but not on disk.

The fixture is `examples/test-repo`, a submodule tracking
[skillkeeper-test-repo](https://github.com/lorem-dev/skillkeeper-test-repo). It
is built so that every documented resolution path has exactly one example, and
its own README explains what each fixture drives.

## Isolation -- read this first

Every step below runs the CLI with **both** `XDG_CONFIG_HOME` and `HOME`
pointed at throwaway directories:

```bash
export XDG_CONFIG_HOME=$(mktemp -d)
export HOME=$(mktemp -d)
```

Both are required, and for different reasons:

- `XDG_CONFIG_HOME` relocates `state.json` and `config.yaml`
  (`crates/skillkeeper-cli/src/wiring.rs`). Without it the run mutates the
  developer's tracked repositories and install records.
- `HOME` relocates the agents' **global** roots. Codex MCP installs always write
  to `~/.codex/config.toml` regardless of the project, and global-scope skill
  installs write under `~`. Without it a fixture run edits the developer's real
  agent configuration.

Never run these steps without both overrides. If a step fails halfway, the only
cleanup needed is removing the temporary directories -- nothing outside them was
touched.

## Steps

### 1. Confirm the submodule is checked out and matches its remote

```bash
git submodule status examples/test-repo
git -C examples/test-repo status --porcelain
git -C examples/test-repo rev-parse HEAD origin/main
```

Expect: a status line with **no** leading `-` (a `-` means uninitialized -- run
`git submodule update --init`), a clean worktree, and `HEAD` equal to
`origin/main`. A dirty worktree or a moved pointer is a finding: the superproject
records which fixture commit it points at, so an unintended bump must not ride
along in an unrelated commit.

If the submodule is absent, report it and stop. It is a fixture, not a
dependency, so its absence never breaks a build -- but this skill cannot run
without it.

### 2. Static checks on the fixture

```bash
cd examples/test-repo
LC_ALL=C grep -rnP '[^\x00-\x7F]' . --exclude-dir=.git    # expect no matches
```

The fixture is ASCII-only, like the rest of the project. Then validate every
machine-readable file:

- Each `*.json` parses (the two hook payloads under `json-hooks-skill/`).
- `mcp.yml`, `tooling/mcp.yml`, and `skillkeeper.repo.yaml.example` parse as
  YAML and declare `version: 1`.
- Every `SKILL.md` and `HOOK.md` starts with a `---` frontmatter block that
  parses as YAML and carries a `name`.

Expect 13 manifests in total: 10 `SKILL.md` (9 resolvable plus the deliberately
unresolvable one) and 3 `HOOK.md`.

### 3. Build the CLI

```bash
cargo build -p skillkeeper-cli
```

Use `target/debug/skillkeeper` for every step below. Building is part of the
check: the fixture run is only meaningful against the current source.

### 4. Add the fixture as a repository

Add it from the local path rather than over SSH, so the check needs no network
and no GitHub key:

```bash
skillkeeper repo add "$PWD/examples/test-repo" "$CLONE" --name fixture
```

Expect `Repository added: fixture (<uuid>)`.

### 5. MCP presets

```bash
skillkeeper mcp list
```

Expect exactly **6** presets: `filesystem`, `github`, `bare-stdio`,
`docs-http`, `events-sse` (all ungrouped, from the root `mcp.yml`) and
`tooling/tooling-registry` (from `tooling/mcp.yml`).

The group-scoped one is the load-bearing assertion: a group's `mcp.yml` is only
discovered when that group holds at least one **resolvable** skill, so if
`tooling/tooling-registry` is missing, group resolution broke -- not MCP parsing.

### 6. Install every installable skill

Eight of the nine resolvable skills install for `claude`; `text-hook-skill` is
for `opencode` (step 8):

```bash
for id in minimal-skill documented-skill script-skill json-hooks-skill \
          tooling/lint-skill tooling/format-skill \
          docs-writing/changelog-skill docs-writing/readme-skill; do
  skillkeeper skill install "$id" --agent claude --project "$PROJ" --allow-hooks
done
```

Expect 8 successes. Then check the three things install is responsible for:

- **Selective `+x`.** Under `$PROJ/.claude/skills/script-skill/`, `bin/run.sh`
  and `bin/check.py` are executable and `lib/shared.sh` is not. All three are
  mode `644` in Git, so the bit can only come from the `executables` list --
  this distinguishes "applied" from "inherited".
- **Guidance precedence.** `$PROJ/.claude/CLAUDE.md` holds **5**
  `SKILLKEEPER_START` blocks, and **zero** occurrences of
  `documented-skill (from RULES.md)`: that skill ships both files and `GUIDE.md`
  must win. (Claude's guidance target is `.claude/CLAUDE.md` when no top-level
  `CLAUDE.md` exists.)
- **Hook merge.** `$PROJ/.claude/settings.json` holds two owned nodes,
  `hooks.PreToolUse` and `hooks.PostToolUse`, each tagged with a `_skillkeeper`
  marker labelled `json-hooks-skill:pre-tool-use` / `:post-tool-use`.

Also run one install **without** `--allow-hooks` and confirm the body installs
while the hooks are skipped with the consent notice.

### 7. The negative fixture and its warning

```bash
skillkeeper skill install too-deep-skill --agent claude --project "$PROJ"
```

Expect `Skill not found in any tracked repository: too-deep-skill` --
`deep-nesting/level-two/too-deep-skill` sits three levels deep and group depth is
exactly one.

Expect **one** warning line on stderr naming `deep-nesting`, printed by any
command that resolves the repository. Two failure modes to watch for:

- **No warning line**: warning propagation regressed, and a misplaced skill is
  invisible again.
- **A warning naming a hidden directory** (`.claude/skills/...`,
  `node_modules/...`): the skip-list regressed. Resolution must ignore hidden
  directories and dependency trees entirely -- silently, since a repository that
  itself uses SkillKeeper legitimately holds installed skills in its own tree.
  Reproduce by creating `$CLONE/.claude/skills/probe/SKILL.md` and confirming no
  warning mentions it.

### 8. The opencode text hook

```bash
skillkeeper skill install text-hook-skill --agent opencode --project "$P2" --allow-hooks
```

Expect a delimited region in `$P2/.opencode/opencode.json` wrapped in
`# >>> skillkeeper:hook text-hook-skill:opencode-region ... >>>`, and the decoy
delimiter lines inside the payload neutralized with a `SK7HOOKGUARD7` guard
token. Un-neutralized decoys mean encapsulation regressed, and region removal
could later stop at the wrong line.

### 9. MCP install, parameters, and the Codex skip

```bash
skillkeeper mcp install docs-http --agent claude --project "$P3" \
  --param host=docs.example.com --param token=sk-test
skillkeeper mcp install bare-stdio --agent claude --project "$P3"
skillkeeper mcp install tooling/tooling-registry --agent claude --project "$P3" \
  --param profile=ci --param registry_url=https://reg.example.com
skillkeeper mcp install events-sse --agent codex --project "$P3" --param host=x.example.com
```

Expect:

- `$P3/.mcp.json` carries the three claude servers with parameters substituted
  in `url`, `headers`, `args`, and `env`.
- `$P3/.claude/skills/.skmcp.yml` records one entry per instance, with `group:
  tooling` present only for the group-scoped one.
- `$P3/.claude/skills/.skmcp.params.yml` records the raw values, and
  `bare-stdio` maps to `{}` -- the zero-parameter path.
- `$P3/.gitignore` gained `.skmcp.params.yml` and `.skmcp.params.yaml` under a
  SkillKeeper comment. These files hold secrets verbatim; if the entry is
  missing, that is a **blocker**, not a nit.
- `rules` rendered into `$P3/.claude/CLAUDE.md` with `{host}`, `{profile}`, and
  `{registry_url}` substituted.
- The codex install reports `Skipped codex: does not support transport "sse".`
  and writes nothing -- confirm `$HOME/.codex` was not created.

### 10. verify and repair round-trip

`verify`, `repair`, and `uninstall` take no `--project`; they act on the current
directory, unlike `install`. Run them from `$PROJ`.

Induce all four drift states, then repair:

```bash
cd "$PROJ"
echo drift >> .claude/skills/documented-skill/reference/notes.md   # modified
rm .claude/skills/documented-skill/RULES.md                        # missing
echo junk > .claude/skills/documented-skill/unrecorded.txt         # extraneous
mkdir -p .claude/skills/documented-skill/stray && echo x > .claude/skills/documented-skill/stray/deep.txt
skillkeeper skill verify documented-skill    # expect FAIL listing all four
skillkeeper skill repair documented-skill    # expect the removed paths listed
skillkeeper skill verify documented-skill    # expect OK
```

Then assert the bounds on repair's deletion, which is the part most worth
guarding:

- `stray/` is gone, pruned along with its file.
- Every **other** installed skill directory is untouched -- `ls .claude/skills/`
  still lists all eight. Repair prunes only within the repaired skill's own
  directory, and protects files recorded by any other install sharing the root.

Finally, uninstall `json-hooks-skill` and confirm both owned hook nodes are
removed (`hooks` becomes `{}`), its guidance block is gone, and the other four
guidance blocks survive.

### 11. Clean up

```bash
rm -rf "$XDG_CONFIG_HOME" "$HOME" "$CLONE" "$PROJ" "$P2" "$P3"
```

Then confirm the repository itself is untouched:

```bash
git status --porcelain                          # expect clean
git -C examples/test-repo status --porcelain     # expect clean
```

A dirty tree here means a step escaped its temporary directory -- report it as a
blocker.

## Report

```
submodule checked out + matches remote: PASS / FAIL
fixture static checks (ASCII/JSON/YAML/frontmatter): PASS / FAIL
CLI builds:                             PASS / FAIL
repo add:                               PASS / FAIL
mcp list (6 presets, incl. grouped):    PASS / FAIL
skill install (8/8):                    PASS / FAIL
executables (+x only where declared):   PASS / FAIL
guidance (5 blocks, GUIDE.md wins):     PASS / FAIL
hook merge (2 owned nodes):             PASS / FAIL
hooks skipped without --allow-hooks:    PASS / FAIL
negative fixture (not found + 1 warning): PASS / FAIL
no warning for hidden directories:      PASS / FAIL
opencode region + encapsulation:        PASS / FAIL
mcp params, ledger, gitignore, rules:   PASS / FAIL
codex non-stdio skipped:                PASS / FAIL
verify -> repair -> verify OK:          PASS / FAIL
repair bounded (siblings untouched):    PASS / FAIL
uninstall reverses hooks + guidance:    PASS / FAIL
no writes outside the temp dirs:        PASS / FAIL

Overall: PASS / FAIL
```

For each failure, include the command, its actual output, and what was expected.
Distinguish a **fixture** problem (the submodule drifted or its content changed)
from a **product** problem (the CLI behaves differently than the fixture
documents) -- they need opposite fixes, and the fixture's own README states the
intended behaviour for every case above.
