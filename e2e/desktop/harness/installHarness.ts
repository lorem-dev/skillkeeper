import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { Scenario } from './scenario.js';
import { UNKNOWN_COMMAND_PREFIX, defaultResponses } from './commands.js';

/**
 * `@tauri-apps/api/mocks` (`mockIPC`, `mockWindows`) cannot be `import`ed from
 * a `page.addInitScript` payload: browsers only resolve bare specifiers
 * (`import('@tauri-apps/api/mocks')`) through an import map, and `vite
 * preview` serves the built production bundle as plain static files with none
 * configured -- that module was never part of the app's own dependency graph
 * in the first place, since the app itself never imports its own test mocks.
 * Bundling the harness with Vite (the brief's other suggested option) would
 * need its own build step just for this.
 *
 * Instead, read the installed package's CommonJS build (`require.resolve`
 * follows the package's "require" export condition to `mocks.cjs`, a script
 * of plain function declarations ending in `exports.mockIPC = mockIPC;` etc.)
 * once, here in Node, and hand its text to the page as init-script *data*
 * (not code) via `installHarness`'s `addInitScript` argument. The page-side
 * function runs that text through `new Function('exports', source)`,
 * supplying the `exports` object the script assigns onto, entirely at
 * page-runtime, with no module resolution involved at all.
 *
 * `@tauri-apps/api` is a dependency of `@skillkeeper/desktop`, not of the
 * repository root (pnpm keeps this suite, like `e2e/cli`, outside the
 * workspace), so it is resolved through a `require` rooted at the desktop
 * package rather than at this file.
 */
const requireFromDesktop = createRequire(fileURLToPath(new URL('../../../apps/desktop/package.json', import.meta.url)));
const TAURI_MOCKS_SOURCE = readFileSync(requireFromDesktop.resolve('@tauri-apps/api/mocks'), 'utf8');

/** Data passed into the page; must stay JSON-serializable end to end (see
 *  `Scenario`'s doc comment on why `responses` cannot carry a function yet). */
interface HarnessInit {
  readonly scenario: Scenario;
  readonly responses: Record<string, unknown>;
  readonly unknownCommandPrefix: string;
  readonly mocksSource: string;
}

/**
 * Installs the scripted backend before any application module runs.
 *
 * `mockIPC` writes `window.__TAURI_INTERNALS__`, and the renderer's `invoke`
 * reads `window.__TAURI_INTERNALS__.invoke(...)` at call time, not at module
 * load -- so this beats every lazily imported route exactly as well as it
 * beats an eagerly imported one. Call this before `page.goto`.
 */
export async function installHarness(page: Page, scenario: Scenario): Promise<void> {
  const init: HarnessInit = {
    scenario,
    responses: defaultResponses(scenario),
    unknownCommandPrefix: UNKNOWN_COMMAND_PREFIX,
    mocksSource: TAURI_MOCKS_SOURCE,
  };

  await page.addInitScript((arg: HarnessInit) => {
    // See the module doc comment: this is the only way to get `mocks.cjs`'s
    // exports out of its source text without a real module system, in a page
    // served as static files with no import map.
    const modFactory = new Function('exports', `${arg.mocksSource}\nreturn exports;`) as (
      exportsObj: Record<string, unknown>,
    ) => {
      mockIPC: (cb: (cmd: string, args: unknown) => unknown, options?: { shouldMockEvents?: boolean }) => void;
      mockWindows: (current: string, ...rest: string[]) => void;
    };
    const { mockIPC, mockWindows } = modFactory({});

    (window as unknown as Record<string, unknown>).__SKK_E2E_CALLS__ = [];
    // Writes recorded by the clipboard stub below, in write order. A spec
    // reads this through `fixture.ts`'s `app.clipboard()` to assert a copy
    // action without a real OS clipboard (there is none in a headless
    // Chromium run, and the Clipboard API needs a user gesture besides).
    (window as unknown as Record<string, unknown>).__SKK_E2E_CLIPBOARD__ = [];
    // Every unmocked command the callback below could not answer, in call
    // order, as `{ cmd, message }` -- `message` is the exact string the
    // thrown `Error` carried (`${unknownCommandPrefix}${cmd}`), kept
    // alongside the bare name rather than reconstructed by a reader, so a
    // spec asserting on it (Task 9's `harness.spec.ts` demonstration) is
    // checking what the harness actually produced, not restating the same
    // template a second time. `store.loadAll` and several call sites swallow
    // a rejection (into `store.error`, a caught background-task status, or a
    // `.then(ok, () => undefined)`), so an unmocked command does not reliably
    // surface anywhere a test's DOM assertions can see it -- a test that
    // needs to know reads this array directly (via `fixture.ts`'s
    // `app.unmocked()`) instead.
    (window as unknown as Record<string, unknown>).__SKK_E2E_UNMOCKED__ = [];
    const label = arg.scenario.windowLabel || 'main';
    (window as unknown as Record<string, unknown>).__SKK_E2E_WINDOW_LABEL__ = label;

    // main.tsx renders SshUnlockApp instead of App when the current window's
    // label is 'ssh-unlock' -- see Scenario's doc comment on windowLabel.
    mockWindows(label);

    // The clipboard-manager plugin command `writeText` invokes -- see
    // `@tauri-apps/plugin-clipboard-manager`'s `writeText`. Handled as a fixed
    // stub rather than a `commands.ts` table entry: a copy action's payload is
    // whatever the app computed at click time, not scenario data, and the
    // recording needs to happen for every scenario without each one having to
    // opt in.
    const CLIPBOARD_WRITE_TEXT = 'plugin:clipboard-manager|write_text';

    // `shouldMockEvents: true` routes every `plugin:event|listen` /
    // `plugin:event|emit` / `plugin:event|unlisten` invoke to mockIPC's own
    // in-page listener registry instead of to the callback below. Without it,
    // the app's first `listen()` call (useConfigWatch's onConfigChanged fires
    // during App's very first effect pass) would throw "unmocked command
    // plugin:event|listen" before the command table below ever got a look in.
    mockIPC(
      (cmd, args) => {
        const calls = (window as unknown as Record<string, unknown>).__SKK_E2E_CALLS__ as unknown[];
        calls.push({ cmd, args });
        if (cmd === CLIPBOARD_WRITE_TEXT) {
          const clipboard = (window as unknown as Record<string, unknown>).__SKK_E2E_CLIPBOARD__ as string[];
          const text = (args as { text?: unknown } | undefined)?.text;
          clipboard.push(typeof text === 'string' ? text : '');
          return null;
        }
        if (!Object.prototype.hasOwnProperty.call(arg.responses, cmd)) {
          const unmocked = (window as unknown as Record<string, unknown>).__SKK_E2E_UNMOCKED__ as {
            cmd: string;
            message: string;
          }[];
          const message = `${arg.unknownCommandPrefix}${cmd}`;
          unmocked.push({ cmd, message });
          throw new Error(message);
        }
        return arg.responses[cmd];
      },
      { shouldMockEvents: true },
    );
  }, init);
}
