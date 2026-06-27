---
name: run-tests-and-linters
description: >
  Install dependencies, run ESLint, run tsc typecheck, and run Vitest with v8
  coverage enforcing the 90% gate. Report any failures clearly with file paths
  and line numbers.
---

# run-tests-and-linters

Run the full quality gate for SkillKeeper.

## Steps

1. **Ensure dependencies are installed.**

   ```bash
   pnpm install
   ```

   If this fails, report the error and stop -- later steps will not produce
   meaningful results.

2. **Run ESLint.**

   ```bash
   pnpm lint
   ```

   Collect any errors or warnings. ESLint errors are blockers; warnings should
   be reported but are not blocking unless the lint script is configured to
   treat them as errors.

3. **Run TypeScript typecheck.**

   ```bash
   pnpm typecheck
   ```

   Any type error is a blocker. Report each error with its file path and line
   number.

4. **Run tests with coverage.**

   ```bash
   pnpm test:cov
   ```

   The Vitest v8 coverage gate requires 90% lines and 90% branches across all
   packages. If the gate fails:
   - Show the coverage summary table.
   - Identify which files or packages are below threshold.
   - Clearly state that the coverage gate is blocking the release.

5. **Report.**
   Produce a structured summary:

   ```
   lint:       PASS / FAIL (N errors, N warnings)
   typecheck:  PASS / FAIL (N errors)
   tests:      PASS / FAIL (N failed, N passed)
   coverage:   PASS / FAIL (lines X%, branches X% -- threshold 90%)

   Overall: PASS / FAIL
   ```

   For each failure include the relevant output excerpt so the developer can
   act on it immediately.
