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
- promotes `## Development` in `CHANGES.md` to `## Version <version>`,
  leaving a fresh empty `## Development` block above it.

If the script exits non-zero, report the error and stop.

### 3. Review the diff

Run `git diff` and confirm the version bump touched exactly these files:
- the 3 `package.json` files (root, `packages/i18n`, `apps/desktop`),
- `apps/desktop/src-tauri/tauri.conf.json` (the Tauri bundle version),
- `Cargo.toml` (the workspace version every crate inherits), and
- `CHANGES.md` (the promoted `## Version <v>` section plus a fresh empty
  `## Development`).

No other files changed. (The old TS domain/CLI packages are gone since the
Tauri migration, so there are only 3 `package.json` files, not the former set.)

### 4. Create the release commit

```bash
git add -A
git commit -m "release: <version>"
```

Do NOT create a tag or push. Cutting the tag (`v<version>`) is a separate,
explicit step performed only after the release gate passes.
