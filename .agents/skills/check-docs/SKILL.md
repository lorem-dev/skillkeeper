---
name: check-docs
description: >
  Verify that the docs/ site, README.md, and CHANGES.md are current with the
  code: nav links resolve, documented commands and options still exist, and
  version references match the current version in package.json.
---

# check-docs

Verify that all project documentation is accurate and up to date.

## Steps

1. **Read the current version.**
   Open the root `package.json` and note the `version` field.

2. **Check README.md.**
   - Confirm every CLI command shown in README.md (`pnpm lint`, `pnpm test:cov`,
     etc.) exists as a script in the root `package.json` or the relevant package
     `package.json`.
   - Confirm the `--filter` names (`@skillkeeper/cli`, `skillkeeper-desktop`)
     match the `name` fields in the respective `package.json` files.
   - Confirm the docs directory reference (`docs/`) exists.

3. **Check docs/ navigation.**
   Open `mkdocs.yml` and verify:
   - Every file listed under `nav:` exists under `docs/`.
   - No nav entry points to a missing file.

4. **Check documented CLI commands.**
   For each command documented in `docs/` (look for fenced code blocks with
   `skillkeeper` invocations), verify the corresponding commander command still
   exists in `packages/cli/src/`. Use `codegraph_search` or file inspection to
   confirm command names and option flags are present in the source.

5. **Check version references.**
   Search `docs/` and `README.md` for version strings. Any hardcoded version
   (e.g., `1.0.0`) must match the version in root `package.json`.

6. **Check CHANGES.md structure.**
   Confirm the file starts with a `## Development` section and that previous
   release sections follow the `## Version X.Y.Z (YYYY-MM-DD)` heading format.

7. **Report.**
   List every issue found (missing files, broken nav links, stale commands,
   version mismatches). If everything is current, report "Docs are current."
   Do not edit documentation automatically -- propose corrections and let the
   developer apply them.
