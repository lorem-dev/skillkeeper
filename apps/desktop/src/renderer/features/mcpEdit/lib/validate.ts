/**
 * Renderer-local validation for the manual MCP preset editor
 * (`McpEditModal`).
 *
 * `validateParamSyntax` mirrors the canonical `validate_param_syntax` in the
 * Rust `skillkeeper-core` crate (covered by its `cargo test` suite). It is
 * reimplemented here rather than crossing the bridge because it must run
 * synchronously as the user types -- see `apps/desktop/docs/architecture.md`,
 * "In the renderer, import only TYPES." (The same call was made for the
 * store's MCP helpers.)
 *
 * `validatePreset` is renderer-only: the config schema for `mcp.servers` is a
 * flat list with no cross-field validation, so the transport-specific
 * required-field rules live here.
 *
 * `oauthFromDraft` also lives here (rather than in
 * `pages/Mcp/lib/mcpPresetMapping.ts`, which owns the rest of the
 * draft/canonical conversions): `McpEditModal`'s `handleSave` calls it
 * directly, and a `features/*` module may not import from `pages/*` (see
 * architecture.md's layer matrix), so the converter has to live inside the
 * feature alongside the draft type it consumes.
 */
import type { McpOauth } from '@/services/bridge';

export type McpTransportDraft = '' | 'stdio' | 'http' | 'sse';

/** One row of a key/value list editor (headers, env). */
export interface KeyValueRow {
  readonly key: string;
  readonly value: string;
}

/**
 * Raw editor state for the oauth section, before being assembled into an
 * `McpOauth` by `oauthFromDraft` (`pages/Mcp/lib/mcpPresetMapping.ts`). Field
 * order is alphabetical (`callbackPort`, `clientId`, `scopes`), matching the
 * canonical hashing order on the Rust side.
 */
export interface McpOauthDraft {
  /** Text, because it comes from a text input; parsed and range-checked on save. */
  readonly callbackPort: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
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
  readonly description: string;
  readonly oauth: McpOauthDraft;
}

/** True for the two transports that can carry an oauth block. */
function isHttpLike(type: McpTransportDraft): boolean {
  return type === 'http' || type === 'sse';
}

/** True when the user put anything at all into the oauth section. Used to
 *  reject a block on a stdio preset without complaining about an untouched
 *  section that merely exists in the draft. */
function hasAnyOauth(oauth: McpOauthDraft): boolean {
  return oauth.clientId.trim() !== '' || oauth.callbackPort.trim() !== '' || oauth.scopes.some((s) => s.trim() !== '');
}

/**
 * Builds the canonical block, or undefined when the user filled nothing in.
 * Scopes stay a list: the agents disagree on the wire type and only the
 * writers know which one each needs. `McpOauth.scopes` is a required field
 * (the Rust side defaults it to an empty `Vec` rather than modelling it as
 * `Option`), so it is always present here, empty array included.
 */
export function oauthFromDraft(draft: McpOauthDraft): McpOauth | undefined {
  const clientId = draft.clientId.trim();
  const scopes = draft.scopes.map((s) => s.trim()).filter((s) => s !== '');
  const port = Number(draft.callbackPort.trim());
  const hasPort = draft.callbackPort.trim() !== '' && Number.isInteger(port);
  if (clientId === '' && scopes.length === 0 && !hasPort) return undefined;
  return {
    ...(hasPort ? { callbackPort: port } : {}),
    ...(clientId !== '' ? { clientId } : {}),
    scopes,
  };
}

export type ParamSyntaxResult = { ok: true } | { ok: false; index: number; reason: string };

/**
 * Validates that every `{` in the text opens a well-formed placeholder: a
 * non-empty run of `[A-Za-z0-9_]` characters followed by `}`. MUST stay
 * byte-for-byte identical to core's `validateParamSyntax`
 * (`packages/core/src/mcp/params.ts`) -- see the drift-guard test.
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
  /** i18n key (`mcp.validation.*`) for the message; resolve with `t()`. */
  readonly messageKey: string;
  /** Interpolation vars for keys that need them (e.g. `invalidParam`'s
   *  `{reason}`/`{index}`). */
  readonly vars?: Readonly<Record<string, string>>;
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
    errors.push({ field: 'name', messageKey: 'mcp.validation.nameRequired' });
  }
  if (draft.type !== 'stdio' && draft.type !== 'http' && draft.type !== 'sse') {
    errors.push({ field: 'type', messageKey: 'mcp.validation.selectType' });
  }
  if (draft.type === 'stdio' && draft.command.trim() === '') {
    errors.push({ field: 'command', messageKey: 'mcp.validation.commandRequired' });
  }
  if ((draft.type === 'http' || draft.type === 'sse') && draft.url.trim() === '') {
    errors.push({ field: 'url', messageKey: 'mcp.validation.urlRequired' });
  }

  if (draft.type === 'stdio' && hasAnyOauth(draft.oauth)) {
    errors.push({ field: 'oauth', messageKey: 'mcp.error.oauthOnStdio' });
  }
  if (isHttpLike(draft.type)) {
    if (draft.oauth.clientId !== '' && draft.oauth.clientId.trim() === '') {
      errors.push({ field: 'oauth.clientId', messageKey: 'mcp.error.clientIdBlank' });
    }
    const rawPort = draft.oauth.callbackPort.trim();
    if (rawPort !== '') {
      const port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push({ field: 'oauth.callbackPort', messageKey: 'mcp.error.callbackPortRange' });
      }
    }
    draft.oauth.scopes.forEach((scope, i) => {
      if (scope !== '' && scope.trim() === '') {
        errors.push({ field: `scopes.${i}`, messageKey: 'mcp.error.scopeBlank' });
      }
    });
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
      errors.push({
        field,
        messageKey: 'mcp.validation.invalidParam',
        vars: { reason: result.reason, index: String(result.index) },
      });
      break;
    }
  }

  return errors;
}
