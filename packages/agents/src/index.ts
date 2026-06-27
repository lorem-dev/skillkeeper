/**
 * Public API of @skillkeeper/agents: the built-in agent adapters and a single
 * registration entry point. The registry is the only place that enumerates
 * concrete agents; adding a new agent means adding a module here and registering
 * it in {@link registerBuiltinAgents}.
 */

import type { AdapterRegistry } from '@skillkeeper/core';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { cursorAdapter } from './cursor.js';
import { opencodeAdapter } from './opencode.js';

export { claudeAdapter } from './claude.js';
export { codexAdapter } from './codex.js';
export { copilotAdapter } from './copilot.js';
export { cursorAdapter } from './cursor.js';
export { opencodeAdapter } from './opencode.js';

export { PROJECT_DIR_ENV } from './paths.js';
export type { AdapterHostEnv } from './paths.js';

/** Every built-in adapter, in a stable order. */
export const builtinAdapters = [
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  cursorAdapter,
  opencodeAdapter,
] as const;

/** Register all five built-in agent adapters into the given registry. */
export function registerBuiltinAgents(registry: AdapterRegistry): void {
  for (const adapter of builtinAdapters) {
    registry.register(adapter);
  }
}
