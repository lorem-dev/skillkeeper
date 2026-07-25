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

## Isolation

The suite never touches the developer's machine state. `e2e/src/cli.ts` is the
only way a spec can invoke the CLI, and it always sets **both**:

- `XDG_CONFIG_HOME`, which relocates `state.json` and `config.yaml`
  (`crates/skillkeeper-cli/src/wiring.rs`) -- otherwise a run would mutate the
  real tracked repositories and install records.
- `HOME`, which relocates the agents' **global** roots. Codex MCP installs always
  write to `~/.codex/config.toml` regardless of the project, and global-scope
  skill installs write under `~`.

Both matter, for different reasons, and forgetting either would silently corrupt
the machine -- which is why the harness owns them rather than each spec.

## Steps

### 1. Run the suite

```bash
pnpm test:e2e
```

That is the whole check. The script behind it
(`scripts/e2e-prepare.mjs`) initializes the fixture submodule, force-pulls it to
the tip of its branch, and builds `target/debug/skillkeeper`; Jest then runs the
specs in `e2e/tests/`.

Set `SKILLKEEPER_E2E_PIN_FIXTURE=1` to run against the fixture commit this
repository pins instead of pulling. CI does that for reproducibility; locally
pulling is the better default, because it surfaces fixture drift early.

### 2. Read the failures with the right lens

Each spec file answers a different question, and which one fails tells you where
to look:

| spec | covers | a failure means |
|---|---|---|
| `e2e/tests/fixture.spec.ts` | the submodule is checked out, ASCII-only, and still has the manifests and file modes the rest of the suite assumes | the **fixture** drifted |
| `e2e/tests/skills.spec.ts` | resolution schemes, `.skid.yml` identity, nested body paths, selective `+x`, guidance precedence, hook merge and consent, the delimited-text region, and both silent-failure modes of the resolver | the **product** changed |
| `e2e/tests/mcp.spec.ts` | preset discovery including the group-scoped file, parameter substitution, both ledger files, the `.gitignore` guard for the secrets file, rules rendering, instance-name allocation, the Codex stdio-only skip, and removal | the **product** changed |
| `e2e/tests/repair.spec.ts` | `verify` -> `repair` -> `verify`, directory pruning, the bounds that keep repair inside the repaired skill, and uninstall reversing hooks and guidance | the **product** changed |

If `fixture.spec.ts` fails, fix or re-pin the fixture. If it passes and another
spec fails, the CLI's behaviour moved and the fixture is telling you so.

### 3. Confirm nothing escaped the sandbox

```bash
git status --porcelain                        # expect clean
git -C examples/test-repo status --porcelain  # expect clean
```

Every spec runs the CLI with throwaway `HOME` and `XDG_CONFIG_HOME`
(`e2e/src/cli.ts`), so a dirty tree here means a test wrote somewhere it should
not have -- a blocker, and a harness defect rather than a product one.

Note that a force-pull may legitimately leave the submodule pointer moved; that
shows as `modified: examples/test-repo (new commits)` in the superproject and is
not a failure. Restore it with `git submodule update -- examples/test-repo`, or
commit the bump on its own.

## Report

Jest already reports per-test results, so summarize rather than restate:

```
pnpm test:e2e:            PASS / FAIL (N passed, N failed of 37)
failing spec(s):          <file> -> <test name>
attributed to:            fixture drift / product change / harness defect
working tree clean after: yes / no
```

For each failure give the test name, the assertion Jest printed, and which of the
three causes it is. Fixture drift and a product change need opposite fixes, and
the fixture's own README states the intended behaviour for every case the suite
covers.
