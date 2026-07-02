/**
 * Config file watcher: polls the config file content once per second and emits a
 * reloaded config result when it changes on disk. Pure over an injected FsPort +
 * emit callback (no electron import), so it is unit-testable. The main process
 * wires `emit` to a webContents push and calls `noteWritten()` after its own
 * writes to avoid echoing them back as external changes.
 */
import { loadConfig } from '@skillkeeper/config';
import type { LoadConfigResult } from '@skillkeeper/config';
import type { FsPort } from '@skillkeeper/core';

const POLL_MS = 1000;

export interface ConfigWatcher {
  start(): void;
  stop(): void;
  /** Poll body; exposed for tests. Reads the file and emits on change. */
  tick(): Promise<void>;
  /** Re-baseline to the current file so a self-write is not surfaced. */
  noteWritten(): Promise<void>;
}

export function createConfigWatcher(
  fs: FsPort,
  configPath: string,
  emit: (result: LoadConfigResult) => void,
): ConfigWatcher {
  let lastText: string | null = null;
  let baselined = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function readText(): Promise<string | null> {
    if (!(await fs.exists(configPath))) return null;
    return fs.readFile(configPath);
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const text = await readText();
      if (!baselined) {
        lastText = text;
        baselined = true;
        return;
      }
      if (text === lastText) return;
      lastText = text;
      if (text !== null) {
        emit(await loadConfig(fs, configPath));
      }
    } finally {
      busy = false;
    }
  }

  async function noteWritten(): Promise<void> {
    lastText = await readText();
    baselined = true;
  }

  return {
    start(): void {
      if (timer !== undefined) return;
      // Establish the baseline immediately, then poll.
      void tick();
      timer = setInterval(() => void tick(), POLL_MS);
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick,
    noteWritten,
  };
}
