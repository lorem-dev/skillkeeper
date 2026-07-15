/**
 * Port for translating a rendered {@link McpServerDef} into one agent's native
 * MCP config file text. All operations are pure text transforms (no I/O): the
 * caller reads the destination file (or passes `''` when it is absent), calls
 * the writer, and writes the result back.
 */
import type { McpServerDef } from '../model.js';

export interface McpConfigWriter {
  /** Add server `name`, or replace it if already present. */
  upsert(text: string, name: string, def: McpServerDef): string;
  /** Drop server `name`. No-op (returns `text` unchanged) if absent. */
  remove(text: string, name: string): string;
  /** All server names currently present, owned or not. */
  existingNames(text: string): string[];
}
