// Jest drives the end-to-end suite in `e2e/` only. Unit tests stay on Vitest
// (`vitest.config.ts`, `pnpm test:cov`) -- the two runners cover different
// layers and never overlap:
//
//   Vitest  pure logic, in-process, coverage-gated at 90%
//   Jest    the built `skillkeeper` binary against a real Git working tree
//
// This file is `.cjs` on purpose: the root package.json sets `"type": "module"`,
// so a `.js` config would be ESM and Jest's config loader plus ts-jest's
// CommonJS transform are simplest kept out of ESM entirely. See e2e/tsconfig.json.
/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/e2e/tests/**/*.spec.ts'],
  // Jest's module map otherwise walks the whole tree and trips over duplicate
  // package.json names: `.claude/worktrees/*` holds full checkouts of this same
  // repository (git worktrees for parallel branches), and the fixture submodule
  // is data the specs read, never modules to resolve.
  modulePathIgnorePatterns: ['<rootDir>/.claude/', '<rootDir>/examples/test-repo/'],
  haste: { retainAllFiles: false },
  watchPathIgnorePatterns: ['<rootDir>/.claude/', '<rootDir>/target/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/e2e/tsconfig.json' }],
  },
  // Each spec adds a repository, installs skills, and shells out to git; the
  // default 5s is far too tight for real process work on a cold cache.
  testTimeout: 120_000,
  // Specs are independent (each owns a throwaway HOME/XDG_CONFIG_HOME), but they
  // all shell out to the same binary and to git. Two workers keeps wall-clock
  // down without turning the run into a process storm on CI runners.
  maxWorkers: 2,
  // A leaked temp directory or a still-running child is a real defect in the
  // harness; surface it instead of letting the run hang silently.
  detectOpenHandles: true,
  forceExit: false,
  verbose: true,
};
