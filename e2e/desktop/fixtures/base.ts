/**
 * The Playwright fixture every desktop spec is built on: a `scenario` test
 * option, and an `app` object wired to whatever that scenario says.
 *
 * `harness/fixture.ts` re-exports `test`/`expect` from here under the path
 * every spec actually imports (`'../harness/fixture'`). This file is the
 * implementation, kept apart from `harness/` on purpose: `harness/` is the
 * backend-scripting mechanism (`Scenario`, `installHarness`, the command
 * table) and knows nothing about Playwright's `test.extend`; this file is
 * testing-framework plumbing layered on top of that mechanism, not part of
 * it.
 */
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installHarness } from '../harness/installHarness.js';
import { defaultScenario } from '../harness/scenario.js';
import type { Scenario } from '../harness/scenario.js';

/** One entry of `window.__SKK_E2E_CALLS__` -- see `installHarness.ts`. */
interface RecordedCall {
  readonly cmd: string;
  readonly args: unknown;
}

/** The spec-facing handle onto one test's scripted backend. */
export interface App {
  /**
   * Zeroes animation/transition durations, then navigates to the app's root.
   * Call once per test, before any assertion or interaction.
   *
   * `reducedMotion: 'reduce'` (see `playwright.config.ts`) is a media-query
   * hint that `motion` only honours where a component asks for it -- this is
   * belt-and-braces on top of that, so a click can never land mid-transition
   * regardless of whether the component checked. The stylesheet is added
   * right after the document exists (immediately post-navigation, before
   * control returns to the spec), not literally before `page.goto` --
   * `addStyleTag` writes into the CURRENT document, and a full navigation
   * replaces that document, so anything added beforehand would not survive
   * the trip anyway.
   */
  goto(): Promise<void>;
  /**
   * Dispatches `payload` to every listener currently registered for `name`,
   * through the same mocked event plugin `@tauri-apps/api/event`'s
   * `listen()`/`emit()` use internally (see `installHarness.ts`'s
   * `shouldMockEvents` note) -- e.g. to drive `skills:progress` at a moment
   * the spec chooses, not whenever a real backend operation would have.
   */
  emit(name: string, payload: unknown): Promise<void>;
  /** Every recorded invocation of `command`, as its `args`, in call order.
   *  Empty when the command was never called. */
  calls(command: string): Promise<unknown[]>;
  /** Every clipboard write recorded so far (see `installHarness.ts`'s
   *  clipboard stub), in write order. */
  clipboard(): Promise<string[]>;
}

function buildApp(page: Page): App {
  return {
    async goto() {
      await page.goto('/');
      await page.addStyleTag({
        content: `*, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }`,
      });
    },
    async emit(name, payload) {
      await page.evaluate(
        ({ name, payload }) => {
          const internals = (
            window as unknown as {
              __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
            }
          ).__TAURI_INTERNALS__;
          return internals.invoke('plugin:event|emit', { event: name, payload });
        },
        { name, payload },
      );
    },
    async calls(command) {
      return page.evaluate((command) => {
        const calls = ((window as unknown as Record<string, unknown>).__SKK_E2E_CALLS__ ?? []) as RecordedCall[];
        return calls.filter((call) => call.cmd === command).map((call) => call.args);
      }, command);
    },
    async clipboard() {
      return page.evaluate(
        () => ((window as unknown as Record<string, unknown>).__SKK_E2E_CLIPBOARD__ ?? []) as string[],
      );
    },
  };
}

interface Fixtures {
  /** The backend data for this test. Override per spec (or per describe
   *  block) with `test.use({ scenario: withScenario({ ... }) })`. */
  scenario: Scenario;
  app: App;
}

export const test = base.extend<Fixtures>({
  scenario: [defaultScenario(), { option: true }],
  app: async ({ page, scenario }, use) => {
    await installHarness(page, scenario);
    await use(buildApp(page));
    // Fail loudly rather than let an unmocked command hide behind a caught
    // rejection (see `installHarness.ts`'s `__SKK_E2E_UNMOCKED__` note).
    // `defaultScenario()` is a complete startup (see `commands.ts`'s Task 3
    // additions for `terminal_start`), so a non-empty list here means either
    // this spec's scenario left a command it actually exercises unanswered,
    // or the renderer started calling a new one this harness has not caught
    // up with -- either way, a passing test that hit this is the wrong
    // outcome, not a flake to retry away (see `playwright.config.ts`'s
    // `retries: 0`).
    const unmocked = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__SKK_E2E_UNMOCKED__ as string[] | undefined,
    );
    if (unmocked && unmocked.length > 0) {
      throw new Error(`e2e harness: unmocked command(s) reached the backend: ${unmocked.join(', ')}`);
    }
  },
});

export { expect };
