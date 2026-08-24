/**
 * Starting the backend shell, and reporting it when that fails.
 *
 * A shell start can fail transiently (the OS refusing a handle under load) or
 * permanently (a host without pseudo-console support). Both used to be silent:
 * the view issued a floating promise, so a failure left a blank terminal and no
 * error anywhere -- and because repository git only runs through the terminal
 * while a session is live, the same dead session made clones print nothing too.
 *
 * These helpers are separated from the view so they are testable without a DOM.
 */

/** How many times to try starting the shell before reporting failure. */
export const START_ATTEMPTS = 3;

/** How long to wait between start attempts, in milliseconds. */
export const START_RETRY_MS = 750;

/** Render `message` as a standalone red line, matching the backend's own. */
export function errorLine(message: string): string {
  return `\r\n\x1b[31m${message}\x1b[0m\r\n`;
}

/** The message of an unknown rejection value. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Injectable delay, so a test does not wait out the real retry interval. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call `start` until it resolves, up to {@link START_ATTEMPTS} times, waiting
 * {@link START_RETRY_MS} between tries. Resolves with the first success;
 * rejects with the LAST failure once the attempts are used up (the last one is
 * the most representative of a standing condition).
 */
export async function startWithRetry(start: () => Promise<string>, sleep: Sleep = realSleep): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    try {
      return await start();
    } catch (err) {
      last = err;
      if (attempt < START_ATTEMPTS - 1) await sleep(START_RETRY_MS);
    }
  }
  throw last;
}
