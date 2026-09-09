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

/** One entry of `window.__SKK_E2E_UNMOCKED__` -- see `installHarness.ts`. */
export interface UnmockedCommand {
  readonly cmd: string;
  readonly message: string;
}

/** The spec-facing handle onto one test's scripted backend. */
export interface App {
  /**
   * Navigates to the app's root. Call once per test, before any assertion or
   * interaction.
   *
   * The animation/transition-zeroing stylesheet is NOT applied here -- it is
   * installed once, per test, via `installAnimationZeroing`'s
   * `page.addInitScript` (see that function's doc comment for why `goto`
   * itself is too late for it).
   */
  goto(): Promise<void>;
  /**
   * Dispatches `payload` to every listener currently registered for `name`,
   * through the same mocked event plugin `@tauri-apps/api/event`'s
   * `listen()`/`emit()` use internally (see `installHarness.ts`'s
   * `shouldMockEvents` note) -- e.g. to drive `skills:progress` at a moment
   * the spec chooses, not whenever a real backend operation would have.
   *
   * LIMITATION, found by Task 5: this cannot land inside a window bounded by a
   * SYNCHRONOUSLY-resolving mocked command. `installHarness.ts`'s mocked
   * `invoke` (the real `@tauri-apps/api/mocks`, read from its own `.cjs`
   * source) is a plain synchronous callback wrapped in an `async` function
   * with no internal `await` -- so a store action chaining two or three such
   * calls (e.g. `applySkills`'s `skills_apply` then `skills_list`) resolves
   * end to end within a single microtask drain, faster than a second,
   * separate Playwright round trip (this method included) can ever arrive: by
   * the time its own `page.evaluate` call reaches the page, the listener the
   * spec meant to reach has usually already been unregistered. Confirmed with
   * a four-point diagnostic (`page.evaluate` sampling DOM state after zero,
   * one, and several microtask/macrotask ticks) before concluding this, not
   * assumed. There is no way to widen that window from a scenario today --
   * `Scenario.responses` values are plain, already-resolved data (see this
   * file's own doc comment on why), not a deferred/gated response a spec
   * could release on demand.
   *
   * Worked example / the only known way around it today:
   * `e2e/desktop/tests/skills.spec.ts`'s "installing a skill" test inlines the
   * exact same `plugin:event|emit` invoke call this method makes, sequenced
   * against the triggering click by microtask ticks (`await
   * Promise.resolve()`) inside ONE `page.evaluate` -- deterministic JS
   * ordering, not a timing guess. Read that spec before reaching for a
   * standalone `app.emit` call anywhere a store action might resolve this
   * fast (the MCP install flow's `applyMcp`/`updateMcp` are likely candidates:
   * same synchronous-mock shape). A proper fix -- a scenario-level
   * gated/deferred response a spec can release on demand -- is intentionally
   * NOT built here; it is scoped as its own task.
   */
  emit(name: string, payload: unknown): Promise<void>;
  /** Every recorded invocation of `command`, as its `args`, in call order.
   *  Empty when the command was never called. */
  calls(command: string): Promise<unknown[]>;
  /** Every clipboard write recorded so far (see `installHarness.ts`'s
   *  clipboard stub), in write order. */
  clipboard(): Promise<string[]>;
  /**
   * Every command the scripted backend could not answer so far, in call
   * order, as recorded by `installHarness.ts`'s mocked `invoke` (see
   * `window.__SKK_E2E_UNMOCKED__`). Reading this directly -- rather than only
   * relying on the fixture's own post-test guard below -- is how a spec
   * proves what the guard actually captured: the `cmd` name AND the exact
   * `message` the thrown `Error` carried, so an assertion against
   * `UNKNOWN_COMMAND_PREFIX` (`harness/commands.ts`) is checking the real
   * runtime string, not a value re-derived to match it.
   *
   * Every other spec in this suite leaves this empty for its whole run --
   * the fixture's own teardown (below) fails the test the instant anything
   * goes unmocked, so there is nothing left here to read afterwards. Calling
   * this is only meaningful in a spec that also sets `expectUnmocked`, the
   * one escape hatch that tells that teardown to expect specific commands
   * here instead of failing on them.
   */
  unmocked(): Promise<UnmockedCommand[]>;
}

/**
 * Zeroes animation/transition durations for every document this `page` ever
 * navigates to, from the very first paint.
 *
 * `reducedMotion: 'reduce'` (see `playwright.config.ts`) is a media-query
 * hint that `motion` only honours where a component asks for it -- this is
 * belt-and-braces on top of that, so a click can never land mid-transition
 * regardless of whether the component checked.
 *
 * This MUST be a `page.addInitScript`, not a post-navigation
 * `page.addStyleTag`: `addInitScript` re-runs on every navigation, before any
 * of the page's own scripts -- exactly the "beats every lazily imported
 * route" guarantee `installHarness.ts` relies on for the backend mocks, and
 * the same guarantee an entrance animation needs here. A style added AFTER
 * `page.goto()` resolves (`load`, by default) arrives long after the
 * document exists and after the app's own scripts started -- an entrance
 * animation triggered on initial mount can start, and finish, before that
 * style ever lands. Since `document.documentElement` may not exist yet at
 * the moment an init script first runs, this falls back to `DOMContentLoaded`
 * when it does not.
 */
async function installAnimationZeroing(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const css = `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }`;
    function insert(): void {
      const style = document.createElement('style');
      style.textContent = css;
      document.documentElement.appendChild(style);
    }
    if (document.documentElement) {
      insert();
    } else {
      document.addEventListener('DOMContentLoaded', insert, { once: true });
    }
  });
}

function buildApp(page: Page): App {
  return {
    async goto() {
      await page.goto('/');
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
    async unmocked() {
      return page.evaluate(
        () => ((window as unknown as Record<string, unknown>).__SKK_E2E_UNMOCKED__ ?? []) as UnmockedCommand[],
      );
    },
  };
}

/** True when `actual` and `expected` name exactly the same commands, ignoring
 *  order (repeated calls to the same never-mocked command all belong to one
 *  name) but NOT count of distinct names or membership -- unlike a subset or
 *  "at least" check, `['a']` against a recorded `['a', 'b']` is a mismatch,
 *  and so is `['a']` against a recorded `[]`. Used only by `expectUnmocked`'s
 *  teardown check below; see that option's doc comment for why an exact match
 *  is the point. */
function sameCommandNames(actual: readonly string[], expected: readonly string[]): boolean {
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

interface Fixtures {
  /** The backend data for this test. Override per spec (or per describe
   *  block) with `test.use({ scenario: withScenario({ ... }) })`. */
  scenario: Scenario;
  /**
   * The exact set of command names this test expects `__SKK_E2E_UNMOCKED__`
   * to hold once the test body finishes -- default `[]`, i.e. every ordinary
   * spec still asserts the array is empty, unchanged from before this option
   * existed.
   *
   * This is the ONLY way to stop the `app` fixture's teardown (below) from
   * failing a test over an unmocked command; it is deliberately not a
   * permissive "allow list" -- the teardown requires the recorded command
   * names to match `expectUnmocked` EXACTLY (same names, same count; see
   * `sameCommandNames`), so `expectUnmocked: ['x']` still fails the test if
   * the harness recorded `['x', 'y']` (a second, unrelated command also went
   * unmocked -- the hatch does not launder that away) or recorded nothing at
   * all (the guard silently stopped firing -- the exact failure mode this
   * option exists to make demonstrable, see `harness.spec.ts`'s "a command
   * with no scripted answer" describe block). A hatch that only suppressed
   * failure, rather than requiring an exact match, would itself become a
   * place a future regression could hide unnoticed -- which is precisely the
   * silence this suite's other assertions exist to rule out.
   *
   * Override per spec (or per describe block) with
   * `test.use({ expectUnmocked: ['command_name'] })`, exactly like `scenario`
   * above. Read what was actually recorded (both the command name and the
   * exact message text) via `app.unmocked()`.
   */
  expectUnmocked: readonly string[];
  app: App;
}

export const test = base.extend<Fixtures>({
  scenario: [defaultScenario(), { option: true }],
  expectUnmocked: [[], { option: true }],
  app: async ({ page, scenario, expectUnmocked }, use) => {
    await installHarness(page, scenario);
    await installAnimationZeroing(page);
    await use(buildApp(page));
    // Fail loudly rather than let an unmocked command hide behind a caught
    // rejection (see `installHarness.ts`'s `__SKK_E2E_UNMOCKED__` note).
    // `defaultScenario()` is a complete startup (see `commands.ts`'s Task 3
    // additions for `terminal_start`), so a non-empty list here means either
    // this spec's scenario left a command it actually exercises unanswered,
    // or the renderer started calling a new one this harness has not caught
    // up with -- either way, a passing test that hit this is the wrong
    // outcome, not a flake to retry away (see `playwright.config.ts`'s
    // `retries: 0`). `expectUnmocked` (default `[]`) is the one escape hatch,
    // and it is checked for an EXACT match, not merely "at most these" -- see
    // that option's own doc comment above.
    const unmocked = ((await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__SKK_E2E_UNMOCKED__ as UnmockedCommand[] | undefined,
    )) ?? []) as UnmockedCommand[];
    const commandNames = unmocked.map((entry) => entry.cmd);
    if (!sameCommandNames(commandNames, expectUnmocked)) {
      if (expectUnmocked.length === 0) {
        throw new Error(`e2e harness: unmocked command(s) reached the backend: ${commandNames.join(', ')}`);
      }
      throw new Error(
        `e2e harness: expected exactly [${expectUnmocked.join(', ')}] to go unmocked, ` +
          `but recorded [${commandNames.join(', ')}]`,
      );
    }
  },
});

export { expect };
