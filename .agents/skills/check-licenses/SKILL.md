---
name: check-licenses
description: >
  Enumerate direct dependencies from all package.json files, check each license
  against the acceptable/unacceptable list in CONTRIBUTING.md, update the
  Third-Party Notices section of LICENSE, and fail if any dependency carries a
  disallowed license.
---

# check-licenses

Verify that every direct dependency is license-compatible with Apache 2.0 and
keep the Third-Party Notices section of `LICENSE` up to date.

## Steps

1. **Collect all direct dependencies.**

   For each `package.json` in the monorepo (root, `packages/*/package.json`,
   `apps/*/package.json`), collect the package names listed under
   `dependencies` and `optionalDependencies`. Do not include
   `devDependencies` (development tools do not ship to end users).

   ```bash
   # Example: list packages with their installed license field
   pnpm licenses list --prod 2>/dev/null || \
     node -e "
       const fs = require('fs');
       const lock = JSON.parse(fs.readFileSync('pnpm-lock.yaml', 'utf8'));
       // fallback: read node_modules/<pkg>/package.json for each dep
     "
   ```

   A reliable fallback is to read `node_modules/<package>/package.json` for
   each direct dependency and extract the `license` field. Use `pnpm list
   --prod --depth 0 --json` to enumerate direct dependencies.

2. **Check each license against the policy (from CONTRIBUTING.md).**

   NOT acceptable:
   - GPL-2.0, GPL-3.0, AGPL-3.0
   - LGPL-2.1 (the Electron app bundles its dependencies, so LGPL's
     dynamic-linking exception does not apply)
   - SSPL-1.0, BSL-1.1
   - Any Creative Commons -NC- variant
   - Any license containing a "Commons Clause" addendum

   Acceptable examples (not exhaustive): MIT, BSD-2-Clause, BSD-3-Clause,
   ISC, Apache-2.0, 0BSD, CC0-1.0.

3. **Flag any disallowed license.**
   If any dependency carries a disallowed license, report it clearly and
   STOP -- do not update `LICENSE`. The developer must replace or remove the
   dependency before the check can pass.

4. **Build the Third-Party Notices table.**
   For each direct production dependency, collect:
   - Package name and version
   - License identifier (SPDX)
   - Copyright line from `node_modules/<package>/package.json` or the
     package's LICENSE file if available

5. **Update LICENSE.**
   Replace the content of the `Third-Party Notices` section in `LICENSE`
   (from the `## Third-Party Notices` heading to the end of file) with:

   ```
   ## Third-Party Notices

   This project uses the following third-party libraries. Each library
   retains its original copyright and is distributed under its respective
   license.

   Entries in this section are maintained automatically by the `check-licenses`
   skill. Run that skill after editing any `package.json` to keep this list
   current and accurate.

   | Package | Version | License | Copyright |
   |---|---|---|---|
   | <name> | <version> | <spdx> | <copyright> |
   ...
   ```

   Do NOT alter any content above the `## Third-Party Notices` heading.
   The Apache 2.0 license text must remain intact.

6. **Report.**
   Print the final table and confirm:
   - "All N direct dependencies are license-compatible."
   - "LICENSE Third-Party Notices updated."

   Or, if any dependency failed: "BLOCKED: <package> uses <license> which is
   not compatible with Apache 2.0. Replace or remove it before merging."
