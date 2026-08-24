/**
 * Tests for `installNotesToMessages`, extracted out of `McpInstallModal`'s
 * `confirm` handler precisely so this mapping (from `UpsertNote` to a
 * user-facing message) can be pinned by a test. A stub translator stands in
 * for the real one: it just records the key and vars it was called with, so
 * assertions can check exactly which message key and interpolation values
 * were chosen, without a React store context.
 */
import { describe, it, expect } from 'vitest';
import type { McpInstalled } from '@/services/bridge';
import type { Translator } from '@/systems/i18n';
import { installNotesToMessages } from './installNotesToMessages';

/** Renders as `key|{"var":"value",...}`, deterministic and easy to assert on. */
const stubTranslator: Translator = ((key: string, vars?: Record<string, string>) =>
  `${key}|${JSON.stringify(vars ?? {})}`) as Translator;

function installed(over: Partial<McpInstalled> & { agent: McpInstalled['agent'] }): McpInstalled {
  return { instanceName: 'instance-1', notes: [], ...over };
}

describe('installNotesToMessages', () => {
  it('returns an empty array when no target carries a note', () => {
    const targets = [installed({ agent: 'claude', notes: [] }), installed({ agent: 'cursor', notes: [] })];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([]);
  });

  it('maps a droppedField note to mcp.oauthFieldDropped with the agent label and field', () => {
    const targets = [installed({ agent: 'cursor', notes: [{ kind: 'droppedField', field: 'callbackPort' }] })];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([
      'mcp.oauthFieldDropped|{"agent":"Cursor","field":"callbackPort"}',
    ]);
  });

  it('maps a codexCallbackConflict note to mcp.codexCallbackConflict with found/wanted as strings', () => {
    const targets = [
      installed({ agent: 'codex', notes: [{ kind: 'codexCallbackConflict', found: '8080', wanted: 8432 }] }),
    ];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([
      'mcp.codexCallbackConflict|{"found":"8080","wanted":"8432"}',
    ]);
  });

  it('passes a non-numeric found value through verbatim', () => {
    // `found` is a rendered description, not a number: a config can hold a
    // port hand-written as a quoted string, or only the callback url. The
    // renderer must not reinterpret it.
    const targets = [
      installed({
        agent: 'codex',
        notes: [{ kind: 'codexCallbackConflict', found: '"http://localhost:9999/callback"', wanted: 8432 }],
      }),
    ];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([
      'mcp.codexCallbackConflict|{"found":"\\"http://localhost:9999/callback\\"","wanted":"8432"}',
    ]);
  });

  it('deduplicates two installs dropping the same field into a single message', () => {
    // Two per-target install records (as `ApplyMcpResult.installed` carries
    // one per agent target) that report the identical dropped field render
    // to the exact same text and must collapse to one notification, not two.
    const targets = [
      installed({ agent: 'cursor', instanceName: 'instance-1', notes: [{ kind: 'droppedField', field: 'callbackPort' }] }),
      installed({ agent: 'cursor', instanceName: 'instance-2', notes: [{ kind: 'droppedField', field: 'callbackPort' }] }),
    ];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([
      'mcp.oauthFieldDropped|{"agent":"Cursor","field":"callbackPort"}',
    ]);
  });

  it('does not collapse the same dropped field across two different agents, since the agent name is part of the text', () => {
    const targets = [
      installed({ agent: 'cursor', notes: [{ kind: 'droppedField', field: 'callbackPort' }] }),
      installed({ agent: 'opencode', instanceName: 'instance-2', notes: [{ kind: 'droppedField', field: 'callbackPort' }] }),
    ];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([
      'mcp.oauthFieldDropped|{"agent":"Cursor","field":"callbackPort"}',
      'mcp.oauthFieldDropped|{"agent":"OpenCode","field":"callbackPort"}',
    ]);
  });

  it('preserves first-seen order and dedupes an exact duplicate note within one target', () => {
    const targets = [
      installed({
        agent: 'opencode',
        notes: [
          { kind: 'droppedField', field: 'callbackPort' },
          { kind: 'droppedField', field: 'scopes' },
          { kind: 'droppedField', field: 'callbackPort' },
        ],
      }),
    ];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([
      'mcp.oauthFieldDropped|{"agent":"OpenCode","field":"callbackPort"}',
      'mcp.oauthFieldDropped|{"agent":"OpenCode","field":"scopes"}',
    ]);
  });

  it('maps an optionSubstituted note to mcp.note.optionSubstituted with the parameter and the substituted value', () => {
    const targets = [
      installed({ agent: 'cursor', notes: [{ kind: 'optionSubstituted', parameter: 'region', value: 'us-east' }] }),
    ];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([
      'mcp.note.optionSubstituted|{"parameter":"region","value":"us-east"}',
    ]);
  });

  it('deduplicates two installs reporting the same optionSubstituted note into a single message', () => {
    const targets = [
      installed({
        agent: 'cursor',
        instanceName: 'instance-1',
        notes: [{ kind: 'optionSubstituted', parameter: 'region', value: 'us-east' }],
      }),
      installed({
        agent: 'cursor',
        instanceName: 'instance-2',
        notes: [{ kind: 'optionSubstituted', parameter: 'region', value: 'us-east' }],
      }),
    ];
    expect(installNotesToMessages(targets, stubTranslator)).toEqual([
      'mcp.note.optionSubstituted|{"parameter":"region","value":"us-east"}',
    ]);
  });
});
