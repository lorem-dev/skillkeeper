---
name: run-tests-and-linters
description: >
  Install dependencies, run the Rust gates (cargo fmt, clippy, test) and the
  TypeScript gates (ESLint, tsc typecheck, Vitest with v8 coverage at 90%, and
  the renderer Vite build). Report any failures clearly with file paths and
  line numbers.
---

# run-tests-and-linters

Run the full quality gate for SkillKeeper. The project is a Rust workspace
(crates + the Tauri backend) plus a small TypeScript surface (the renderer and
the `packages/i18n` catalogs), so the gate has both a Rust half and a
TypeScript half.

## Steps

1. **Ensure dependencies are installed.**

   ```bash
   pnpm install
   ```

   The stable Rust toolchain is pinned in `rust-toolchain.toml` and installed
   by rustup on first `cargo` invocation. If `pnpm install` fails, report the
   error and stop -- later steps will not produce meaningful results.

2. **Run the Rust gates.**

   ```bash
   cargo fmt --all --check                              # formatting
   cargo clippy --workspace --all-targets -- -D warnings # lints; warnings fail (matches CI)
   cargo test --workspace                               # tests; also regenerates the ts-rs bindings
   ```

   Any `cargo fmt --check` diff, clippy warning, or failed test is a blocker.
   Report each with its crate, file path, and line number. Note that
   `cargo test` regenerates the TypeScript bindings under
   `apps/desktop/src/renderer/services/bridge/generated/`; if that leaves a
   dirty working tree, the bindings were stale and must be committed.

3. **Run ESLint.**

   ```bash
   pnpm lint
   ```

   Collect any errors or warnings. ESLint errors are blockers; warnings should
   be reported but are not blocking unless the lint script is configured to
   treat them as errors.

4. **Run TypeScript typecheck.**

   ```bash
   pnpm typecheck
   ```

   Any type error is a blocker. Report each error with its file path and line
   number.

5. **Run tests with coverage.**

   ```bash
   pnpm test:cov
   ```

   The Vitest v8 coverage gate requires 90% lines and 90% branches; it is
   scoped to `packages/i18n` (see `vitest.config.ts`). If the gate fails:
   - Show the coverage summary table.
   - Identify which files are below threshold.
   - Clearly state that the coverage gate is blocking the release.

6. **Build the renderer.**

   ```bash
   pnpm --filter @skillkeeper/desktop frontend:build   # vite build
   ```

   A failed frontend build is a blocker.

7. **Report.**
   Produce a structured summary:

   ```
   cargo fmt:   PASS / FAIL
   cargo clippy: PASS / FAIL (N warnings)
   cargo test:  PASS / FAIL (N failed, N passed)
   lint:        PASS / FAIL (N errors, N warnings)
   typecheck:   PASS / FAIL (N errors)
   tests:       PASS / FAIL (N failed, N passed)
   coverage:    PASS / FAIL (lines X%, branches X% -- threshold 90%)
   frontend:    PASS / FAIL

   Overall: PASS / FAIL
   ```

   For each failure include the relevant output excerpt so the developer can
   act on it immediately.
