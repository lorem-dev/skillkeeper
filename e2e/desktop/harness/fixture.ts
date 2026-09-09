/**
 * The name every spec imports the scenario-driven `test`/`expect` from
 * (`import { test, expect } from '../harness/fixture'`).
 *
 * The implementation lives in `../fixtures/base.ts` -- see that file's doc
 * comment for why the two are separate. This module exists so a spec reaches
 * for it alongside the rest of the harness (`scenario.ts`, `installHarness.ts`
 * are both in this directory) without needing to know about the `fixtures/`
 * split.
 */
export { test, expect } from '../fixtures/base.js';
export type { App, UnmockedCommand } from '../fixtures/base.js';
