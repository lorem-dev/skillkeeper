/**
 * Drift guard: every field `validatePreset` can report must have a place in
 * `McpEditModal` that renders its MESSAGE, not just a red border.
 *
 * Four of the oauth error keys shipped translated into 18 catalogs and could
 * never appear: the oauth controls set `invalid` and passed `invalidIndex` but
 * rendered no text, and `mcp.error.oauthOnStdio` had no render site at all --
 * its whole section is hidden at stdio, which is exactly when it fires. The
 * user got a red border and a disabled Save with no explanation.
 *
 * Renderer tests here are node-only (no jsdom, no React render), so the modal
 * cannot be mounted and queried. What IS checkable is the source: the field
 * names come from running the real validator, and the render sites are read
 * out of the component's own text. That catches the shape of the regression --
 * adding a validation error and forgetting to display it.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { McpPresetDraft } from './validate';
import { validatePreset } from './validate';

const MODAL_SOURCE = readFileSync(
  new URL('../ui/McpEditModal.tsx', import.meta.url),
  'utf8',
);

function draft(over: Partial<McpPresetDraft>): McpPresetDraft {
  return {
    name: 'preset',
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: [],
    command: '',
    args: [],
    env: [],
    rules: '',
    description: '',
    oauth: { callbackPort: '', clientId: '', scopes: [] },
    ...over,
  };
}

/** One draft per oauth validation rule, each triggering exactly that rule. */
const OAUTH_CASES: Record<string, McpPresetDraft> = {
  oauth: draft({ type: 'stdio', command: 'run', oauth: { callbackPort: '', clientId: 'example-client', scopes: [] } }),
  'oauth.clientId': draft({ oauth: { callbackPort: '', clientId: ' ', scopes: [] } }),
  'oauth.callbackPort': draft({ oauth: { callbackPort: '70000', clientId: '', scopes: [] } }),
  'scopes.0': draft({ oauth: { callbackPort: '', clientId: '', scopes: [' '] } }),
};

describe('McpEditModal renders every oauth validation message', () => {
  for (const [field, input] of Object.entries(OAUTH_CASES)) {
    it(`reports ${field} and the modal renders its text`, () => {
      // The case must actually trigger the rule, or the render assertion below
      // would pass on a validator that reports nothing at all.
      const reported = validatePreset(input).map((e) => e.field);
      expect(reported).toContain(field);

      // Indexed fields (`scopes.0`) are rendered through `rowErrorFor`, which
      // matches on the prefix because the index is not known up front.
      const site = field.includes('.') && /\.\d+$/.test(field)
        ? `rowErrorFor('${field.split('.')[0]!}')`
        : `errorFor('${field}')`;
      expect(MODAL_SOURCE).toContain(`sk-mcp-edit__error">{${site}}`);
    });
  }
});
