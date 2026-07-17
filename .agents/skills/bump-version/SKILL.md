---
name: bump-version
description: >
  Set the monorepo version across all package.json files and promote the
  CHANGES.md Development section to a released Version section, then create the
  release commit. Does not tag or push.
---

# bump-version

Bump the SkillKeeper version and prepare the release commit. Tagging and
pushing remain separate, deliberate steps.

## Steps

### 1. Require a clean working tree

Run `git status --short`. If there is any output, stop and ask the developer
to commit or stash first. The bump must be reviewable as an isolated diff.

### 2. Run the bump script

Run `node scripts/bump-version.mjs <version>` with the target version (for
example `0.1.0-rc.1`). The script:
- writes `<version>` into the root and all workspace `package.json` files, and
- promotes `## Development` in `CHANGES.md` to `## Version <version> - <date>`,
  leaving a fresh empty `## Development` block above it.

If the script exits non-zero, report the error and stop.

### 3. Review the diff

Run `git diff` and confirm: exactly 7 `package.json` files changed to the new
version, and `CHANGES.md` shows the promoted section plus a new empty
`## Development`. No other files changed.

### 4. Create the release commit

```bash
git add -A
git commit -m "release: <version>"
```

Do NOT create a tag or push. Cutting the tag (`v<version>`) is a separate,
explicit step performed only after the release gate passes.
