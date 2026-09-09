---
name: check-glibc-floor
description: >
  Verify the Linux glibc floor is consistent everywhere it is stated: the
  release workflow's runner image is the source of truth, and scripts/install.sh,
  docs/, and the release download labels must all agree with it. Also confirms
  the statically linked musl CLI is still built and published.
---

# check-glibc-floor

The prebuilt `*-linux-gnu` CLI and the desktop bundles are linked against the
glibc of the runner image that builds them. glibc versions its symbols, and the
compatibility runs one way only: a newer glibc runs older binaries, an older one
cannot run newer binaries. So that image's version is a hard floor -- below it
the binary exits with ``libc.so.6: version `GLIBC_2.34' not found`` before
running any code.

That floor is a single fact restated across six files: `release.yml` itself,
`scripts/install.sh`, `scripts/release-downloads.mjs`, `docs/getting-started.md`,
`docs/troubleshooting.md`, and `CHANGES.md`. Several of them say it more than
once, so check every occurrence rather than counting them. This skill verifies
they all still say the same number, and that the musl escape hatch is still
shipped.

**The source of truth is the Linux runner image in
`.github/workflows/release.yml`.** Nothing else. When they disagree, the image
is right and the other places are stale.

## Runner image to glibc

| Image | glibc |
|---|---|
| `ubuntu-20.04` | 2.31 (image retired; here for reading older workflows) |
| `ubuntu-22.04`, `ubuntu-22.04-arm` | 2.35 |
| `ubuntu-24.04`, `ubuntu-24.04-arm` | 2.39 |
| `ubuntu-latest` | whatever it currently aliases (2.39 at the time of writing) |

If the image is not in this table, look up its glibc before continuing rather
than guessing, and add the row.

## Steps

### 1. Read the floor from the release workflow

```bash
grep -n "os: ubuntu" .github/workflows/release.yml
```

Map every Linux leg through the table above. Expect one image across all Linux
legs; if the x64 and arm64 legs differ, the floor is the HIGHER of the two and
that divergence is itself a finding worth reporting.

`ubuntu-latest` on a Linux leg is a finding on its own: it is a moving alias, so
it silently raises the floor whenever the platform re-points it. The Linux legs
must pin an explicit image.

Call the result FLOOR (for example `2.35`).

### 2. Verify scripts/install.sh

```bash
grep -n "MIN_GLIBC_MAJOR\|MIN_GLIBC_MINOR" scripts/install.sh
```

- `MIN_GLIBC_MAJOR` and `MIN_GLIBC_MINOR` must equal FLOOR.

Then confirm each of these is still present and wired up; every one of them is
load-bearing, and the script silently installs an unrunnable binary if any is
dropped:

- `glibc_version` detects the host version, trying `getconf GNU_LIBC_VERSION`
  first and `ldd --version` second, and yields nothing on a musl host.
- It rejects any value that is not a dotted number, because the comparison
  below it is arithmetic.
- `linux_libc` compares against `MIN_GLIBC_*` and returns `musl` when the host
  is below the floor, when there is no glibc at all, and when the version could
  not be read.
- `SKILLKEEPER_LIBC` is validated at the TOP LEVEL of the script, not inside
  `linux_libc`. `linux_libc` runs in a command substitution, where `err` would
  exit only the subshell and leave the caller building a truncated target
  triple.
- The Linux branch composes the triple from the detected libc, rather than
  hardcoding `-gnu`.
- A missing musl asset falls back to the gnu archive with a warning (older
  releases predate the musl archives), and that fallback is skipped when
  `SKILLKEEPER_LIBC` named a flavour explicitly.
- The final smoke run points at `SKILLKEEPER_LIBC=musl` when the installed gnu
  binary fails to start.

Exercise the detection rather than only reading it. This stubs `getconf` and
`ldd` on PATH, sources the two real functions out of the script, and reads the
real `MIN_GLIBC_*`, so it tests the shipped threshold rather than a copy of it.
It runs anywhere, the developer's macOS included:

```bash
d=$(mktemp -d)
# Anchored on the function syntax, not on comment text, and then checked: a
# range that failed to find its end would run to EOF and capture the whole
# install flow, which the `.` below would EXECUTE -- downloading and writing to
# $HOME, once per row. The two guards make that impossible rather than unlikely.
sed -n '/^glibc_version() {/,/^}/p;/^linux_libc() {/,/^}/p' scripts/install.sh > "$d/funcs.sh"
grep -qE 'download |INSTALL_DIR|asset_url|Done\.' "$d/funcs.sh" &&
  { echo "ABORT: extraction captured installer flow, do not source it"; exit 1; }
[ "$(grep -c '^}' "$d/funcs.sh")" = 2 ] ||
  { echo "ABORT: expected exactly 2 functions"; exit 1; }

# Heredocs, not printf: a printf format string containing %s consumes it
# itself and writes a stub that ignores its argument, which silently turns
# every row below into "no glibc" and the whole table into musl.
cat > "$d/getconf" <<'EOF'
#!/bin/sh
[ "${1:-}" = GNU_LIBC_VERSION ] || exit 1
[ -n "${SK_GLIBC:-}" ] || exit 1
printf 'glibc %s\n' "$SK_GLIBC"
EOF
cat > "$d/ldd" <<'EOF'
#!/bin/sh
echo "musl libc (x86_64)"
EOF
chmod +x "$d/getconf" "$d/ldd"

for v in 2.28 2.31 2.34 2.35 2.39 ""; do
  out=$(SK_GLIBC="$v" PATH="$d:$PATH" SK_F="$d/funcs.sh" sh -c '
    eval "$(grep "^MIN_GLIBC_" scripts/install.sh)"
    LIBC=auto
    err() { echo "error: $1" >&2; exit 1; }
    . "$SK_F"
    linux_libc')
  printf 'glibc %-6s -> %s\n' "${v:-none}" "$out"
done
rm -rf "$d"
```

Expected, for a floor of 2.35. The boundary is exercised from both sides, and
`none` stands for a host with no glibc at all, as on Alpine:

```
glibc 2.28   -> musl
glibc 2.31   -> musl
glibc 2.34   -> musl
glibc 2.35   -> gnu
glibc 2.39   -> gnu
glibc none   -> musl
```

Any `ABORT` line, or a table differing from this one, is a FAIL: either the
detection changed or the extraction no longer matches the functions. Do not
adjust the test to make it pass. Also run `sh -n scripts/install.sh`.

### 3. Verify the musl builds are still published

```bash
grep -n "musl" .github/workflows/release.yml
```

- Both Linux legs carry a `musl_target` (`x86_64-unknown-linux-musl` and
  `aarch64-unknown-linux-musl`); every non-Linux leg carries an empty one.
- The toolchain step installs the musl target alongside the leg's own.
- A `Build the CLI (static, musl)` step and its `tar.gz` archive step both run
  when `musl_target` is non-empty, and the archive lands in `dist-cli/`, which
  the upload step collects.

The musl archive is published ALONGSIDE the gnu one, never instead of it:
`SKILLKEEPER_VERSION` can pin an older release, and existing installs resolve
the asset name they already know.

### 4. Verify the documentation states FLOOR

```bash
grep -rn "glibc" docs/ README.md CHANGES.md
```

`CHANGES.md` is in scope deliberately: it states the floor in the entry that
introduced the musl builds, and a runner-image bump would otherwise leave the
changelog quietly asserting the old number while this gate reported CONSISTENT.

Every stated version must equal FLOOR. At the time of writing that is:

- `docs/getting-started.md` -- the System requirements table (CLI and desktop
  rows) and the install-script paragraph.
- `docs/troubleshooting.md` -- the `GLIBC_2.34' not found` section.
- `CHANGES.md` -- the musl entry under the current version.

Distribution versions named as remedies are part of this check, not decoration:
verify each one actually clears FLOOR before repeating it. RHEL 9, for
instance, ships glibc 2.34 and does NOT clear a floor of 2.35.

The troubleshooting section must still say all of: the download is not corrupt,
the musl build is the fix, `SKILLKEEPER_LIBC=musl` is the command, building from
source also works, and upgrading glibc in place is not the answer (the
distribution release pins it). Removing the last point invites someone to break
a machine.

### 5. Verify the release download labels

```bash
grep -n "note:" scripts/release-downloads.mjs
```

The two `*-linux-gnu` entries must carry a `glibc <FLOOR>+` note and the two
`*-linux-musl` entries a `static, musl` note, so a reader picking an asset by
hand can tell which one runs on their host. All four Linux triples must be in
`CLI_TARGETS`; an unlisted one degrades to a bare triple label.

### 6. Check whether the floor rose since the last release

This is the one case that reaches users who already have the app installed.

```bash
git diff "$(git describe --tags --abbrev=0)" -- .github/workflows/release.yml | grep -E "^[+-].*os: ubuntu"
```

No `..HEAD` on purpose: that form compares committed history only, so during
release prep -- exactly when this skill runs -- a runner-image bump still
sitting in the working tree would read as "floor unchanged". The two-dot-free
form covers committed and uncommitted alike. No output means the image did not
move.

If the Linux runner image changed since the last release tag, say so loudly and
report the old and new floors. A raised floor means hosts between the two
versions run the current desktop app fine but cannot run the next one, and the
self-updater has no glibc gate: `platform.rs::asset_key` selects on os/arch
only, and `versions.json` records no minimum (see `scanAssets` in
`scripts/gen-versions-json.mjs`). Those hosts would download, install, and end
up with an app that will not start.

Raising the floor is therefore a release decision, not an incidental bump. Flag
it for the developer; do not decide it inside this skill.

### 7. Report

```
runner image / floor:      ubuntu-22.04 -> glibc 2.35
install.sh MIN_GLIBC_*:    PASS / FAIL
install.sh detection:      PASS / FAIL
musl builds published:     PASS / FAIL
docs state the floor:      PASS / FAIL
download labels:           PASS / FAIL
floor unchanged since tag: PASS / RAISED (2.35 -> 2.39)

glibc floor: CONSISTENT / INCONSISTENT
```

List every mismatch with its file and line and the value it should hold. Do not
edit files automatically -- propose the corrections and let the developer apply
them.
