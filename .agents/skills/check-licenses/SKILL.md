---
name: check-licenses
description: >
  Enumerate direct dependencies from every Cargo.toml and package.json,
  check each license against the acceptable/unacceptable list in
  CONTRIBUTING.md, update the Third-Party Notices section of LICENSE, and fail
  if any dependency carries a disallowed license.
---

# check-licenses

Verify that every direct dependency -- cargo crates and npm packages alike --
is license-compatible with Apache 2.0 and keep the Third-Party Notices section
of `LICENSE` up to date. SkillKeeper is a Rust workspace (crates + the Tauri
backend) plus the `packages/i18n` and `apps/desktop` npm packages, so both
ecosystems must be checked.

## Steps

1. **Collect all direct dependencies (both ecosystems).**

   **Cargo (Rust):** for the workspace `Cargo.toml` and each member's
   `Cargo.toml` (`crates/*/Cargo.toml`, `apps/desktop/src-tauri/Cargo.toml`),
   collect the crate names under `[dependencies]` (and any
   `[workspace.dependencies]`). Do not include `[dev-dependencies]` or
   `[build-dependencies]` (they do not ship to end users). Resolve each crate's
   license from crates.io metadata; a reliable approach is:

   ```bash
   cargo license 2>/dev/null || cargo metadata --format-version=1
   ```

   `cargo metadata` returns every resolved package with its `license` (SPDX)
   field; filter to the direct dependencies you collected from the manifests.

   **npm (TypeScript):** for each `package.json` in the monorepo (root,
   `packages/*/package.json`, `apps/*/package.json`), collect the package names
   under `dependencies` and `optionalDependencies`. Do not include
   `devDependencies`.

   ```bash
   # Example: list npm packages with their installed license field
   pnpm licenses list --prod 2>/dev/null || \
     node -e "
       const fs = require('fs');
       const lock = JSON.parse(fs.readFileSync('pnpm-lock.yaml', 'utf8'));
       // fallback: read node_modules/<pkg>/package.json for each dep
     "
   ```

   A reliable npm fallback is to read `node_modules/<package>/package.json` for
   each direct dependency and extract the `license` field. Use `pnpm list
   --prod --depth 0 --json` to enumerate direct npm dependencies.

2. **Check each license against the policy (from CONTRIBUTING.md).**

   The policy applies identically to cargo crates and npm packages.

   NOT acceptable:
   - GPL-2.0, GPL-3.0, AGPL-3.0
   - LGPL-2.1 (the desktop app bundles its dependencies statically, so LGPL's
     dynamic-linking exception does not apply)
   - SSPL-1.0, BSL-1.1
   - Any Creative Commons -NC- variant
   - Any license containing a "Commons Clause" addendum

   Acceptable examples (not exhaustive): MIT, BSD-2-Clause, BSD-3-Clause,
   ISC, Apache-2.0, 0BSD, CC0-1.0. Note that many crates declare a dual
   license such as `MIT OR Apache-2.0`; a dual license is acceptable if at
   least one of its options is on the acceptable list.

3. **Flag any disallowed license.**
   If any dependency carries a disallowed license, report it clearly and
   STOP -- do not update `LICENSE`. The developer must replace or remove the
   dependency before the check can pass.

4. **Build the Third-Party Notices table.**
   For each direct production dependency (cargo and npm), collect:
   - Package name and version
   - Ecosystem (cargo or npm)
   - License identifier (SPDX)
   - Copyright line: for npm from `node_modules/<package>/package.json` or the
     package's LICENSE file; for cargo from the crate's `authors`/LICENSE via
     `cargo metadata` or the crates.io page.

5. **Update LICENSE.**
   Under `## Third-Party Notices`, update ONLY the `### Software dependencies`
   subsection's table -- replace from its `| Package |` header row to the end of
   file. The table lists BOTH ecosystems (cargo crates and npm packages), cargo
   entries first then npm, each alphabetical:

   ```
   | Package | Ecosystem | Version | License | Copyright |
   |---|---|---|---|---|
   | <name> | cargo / npm | <version> | <spdx> | <copyright> |
   ...
   ```

   Preserve everything else verbatim: the Apache 2.0 license text, the
   `## Third-Party Notices` heading, the `### Bundled fonts` subsection (the
   OFL fonts are NOT a package-manager dependency -- never drop it), and the
   intro paragraph above the table. Do NOT alter any content above the
   `### Software dependencies` table.

6. **Report.**
   Print the final table and confirm:
   - "All N direct dependencies (C cargo, M npm) are license-compatible."
   - "LICENSE Third-Party Notices updated."

   Or, if any dependency failed: "BLOCKED: <package> uses <license> which is
   not compatible with Apache 2.0. Replace or remove it before merging."
