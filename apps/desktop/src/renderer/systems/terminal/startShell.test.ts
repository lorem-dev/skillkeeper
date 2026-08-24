import { describe, it, expect, vi } from 'vitest';
import { START_ATTEMPTS, errorLine, errorText, startWithRetry } from './startShell.js';

/** A sleep that resolves immediately, so retries do not slow the suite. */
const noSleep = async (): Promise<void> => undefined;

describe('startWithRetry', () => {
  it('returns the first success without retrying', async () => {
    const start = vi.fn(async () => 'buffer');
    await expect(startWithRetry(start, noSleep)).resolves.toBe('buffer');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    let calls = 0;
    const start = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('resource busy');
      return 'scrollback';
    });
    await expect(startWithRetry(start, noSleep)).resolves.toBe('scrollback');
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt budget and rejects with the LAST error', async () => {
    let calls = 0;
    const start = vi.fn(async () => {
      calls += 1;
      throw new Error(`attempt ${calls}`);
    });
    await expect(startWithRetry(start, noSleep)).rejects.toThrow(`attempt ${START_ATTEMPTS}`);
    expect(start).toHaveBeenCalledTimes(START_ATTEMPTS);
  });

  it('waits between attempts', async () => {
    const sleep = vi.fn(async () => undefined);
    const start = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(startWithRetry(start, sleep)).rejects.toThrow('nope');
    // One wait fewer than attempts: no point sleeping after the last one.
    expect(sleep).toHaveBeenCalledTimes(START_ATTEMPTS - 1);
  });
});

describe('errorText', () => {
  it('uses an Error message', () => {
    expect(errorText(new Error('cannot open a pseudo-terminal'))).toBe('cannot open a pseudo-terminal');
  });

  it('stringifies a non-Error rejection', () => {
    // Tauri rejects commands with a plain string, not an Error.
    expect(errorText('cannot start the shell')).toBe('cannot start the shell');
  });
});

describe('errorLine', () => {
  it('frames the message on its own colored line', () => {
    const line = errorLine('Terminal unavailable: no conpty');
    expect(line.startsWith('\r\n\x1b[31m')).toBe(true);
    expect(line.endsWith('\x1b[0m\r\n')).toBe(true);
    expect(line).toContain('Terminal unavailable: no conpty');
  });
});
