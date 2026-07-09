/**
 * Renderer-local validation for the manual MCP preset editor
 * (`McpEditModal`).
 *
 * `validateParamSyntax` mirrors `packages/core/src/mcpParams.ts`'s function
 * of the same name byte-for-byte (pinned by the drift-guard test in
 * `validate.test.ts`). It is duplicated here rather than imported because
 * `@skillkeeper/core`'s barrel pulls Node-only runtime deps (`node:fs`,
 * `node:child_process`, `crypto`, ...) into the renderer bundle -- see
 * `apps/desktop/docs/architecture.md`, "In the renderer, import only TYPES."
 * (The same call was made for the store's MCP helpers in task C1.)
 *
 * `validatePreset` is net-new: the config schema for `mcp.servers`
 * (`packages/config/src/schema.ts`) is a flat list with no cross-field
 * validation, so the transport-specific required-field rules live here.
 */

export type McpTransportDraft = '' | 'stdio' | 'http' | 'sse';

/** One row of a key/value list editor (headers, env). */
export interface KeyValueRow {
  readonly key: string;
  readonly value: string;
}

/**
 * Raw editor form state, before being assembled into an `McpServerDef`. Kept
 * separate from the def shape because the editor tracks headers/env as an
 * ordered list of rows (so a user can edit a key without losing the row) and
 * never discards a field's text when the transport type changes.
 */
export interface McpPresetDraft {
  readonly name: string;
  readonly type: McpTransportDraft;
  readonly url: string;
  readonly headers: readonly KeyValueRow[];
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly KeyValueRow[];
  readonly rules: string;
}

export type ParamSyntaxResult = { ok: true } | { ok: false; index: number; reason: string };

/**
 * Validates that every `{` in the text opens a well-formed placeholder: a
 * non-empty run of `[A-Za-z0-9_]` characters followed by `}`. MUST stay
 * byte-for-byte identical to core's `validateParamSyntax`
 * (`packages/core/src/mcpParams.ts`) -- see the drift-guard test.
 */
export function validateParamSyntax(text: string): ParamSyntaxResult {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    const close = text.indexOf('}', i + 1);
    if (close === -1) {
      return { ok: false, index: i, reason: 'unclosed {' };
    }
    const name = text.slice(i + 1, close);
    if (name.length === 0) {
      return { ok: false, index: i, reason: 'empty {}' };
    }
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      return { ok: false, index: i, reason: `illegal character in {${name}}` };
    }
    i = close;
  }
  return { ok: true };
}

export interface FieldError {
  /** Dot/bracket-free path identifying the offending field, e.g. `url`,
   *  `headers.0.value`, `args.2`. The modal uses this to place the message
   *  next to the right control. */
  readonly field: string;
  readonly message: string;
}

/**
 * Structural + param-syntax validation for a preset draft. Structural rules
 * (name required, transport-specific required field) are all reported at
 * once; at most one param-syntax error is reported, for the first offending
 * field in url -> headers -> command -> args -> env -> rules order, mirroring
 * the field scan order a user fills the form in.
 */
export function validatePreset(draft: McpPresetDraft): FieldError[] {
  const errors: FieldError[] = [];

  if (draft.name.trim() === '') {
    errors.push({ field: 'name', message: 'Name is required.' });
  }
  if (draft.type !== 'stdio' && draft.type !== 'http' && draft.type !== 'sse') {
    errors.push({ field: 'type', message: 'Select a transport type.' });
  }
  if (draft.type === 'stdio' && draft.command.trim() === '') {
    errors.push({ field: 'command', message: 'Command is required for stdio servers.' });
  }
  if ((draft.type === 'http' || draft.type === 'sse') && draft.url.trim() === '') {
    errors.push({ field: 'url', message: 'URL is required for http/sse servers.' });
  }

  // Scope the param-syntax scan to fields the active transport actually
  // renders, exactly like the structural checks above. Field values persist
  // across a transport-type switch, so scanning stale values (e.g. a `url`
  // typed under http, then switched to stdio) would dead-end the user: Save
  // stays disabled on a `field:'url'` error for a field that isn't shown.
  const paramFields: { field: string; text: string }[] = [];
  if (draft.type === 'http' || draft.type === 'sse') {
    if (draft.url !== '') paramFields.push({ field: 'url', text: draft.url });
    draft.headers.forEach((row, i) => {
      if (row.key.trim() !== '') paramFields.push({ field: `headers.${i}.value`, text: row.value });
    });
  }
  if (draft.type === 'stdio') {
    if (draft.command !== '') paramFields.push({ field: 'command', text: draft.command });
    draft.args.forEach((arg, i) => paramFields.push({ field: `args.${i}`, text: arg }));
    draft.env.forEach((row, i) => {
      if (row.key.trim() !== '') paramFields.push({ field: `env.${i}.value`, text: row.value });
    });
  }
  if (draft.rules !== '') paramFields.push({ field: 'rules', text: draft.rules });

  for (const { field, text } of paramFields) {
    const result = validateParamSyntax(text);
    if (!result.ok) {
      errors.push({ field, message: `Invalid parameter (${result.reason}) at position ${result.index}.` });
      break;
    }
  }

  return errors;
}
