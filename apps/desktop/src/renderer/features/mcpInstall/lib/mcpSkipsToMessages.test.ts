/**
 * Tests for `mcpSkipsToMessages`. The same stub-translator approach as
 * `installNotesToMessages.test.ts`: the key and vars are recorded verbatim, so
 * a test can assert exactly which message a skip reason chose without a React
 * store context.
 */
import { describe, it, expect } from 'vitest';
import type { McpSkipped } from '@/services/bridge';
import type { Translator } from '@/systems/i18n';
import { mcpSkipsToMessages } from './mcpSkipsToMessages';

/** Renders as `key|{"var":"value",...}`, deterministic and easy to assert on. */
const stubTranslator: Translator = ((key: string, vars?: Record<string, string>) =>
  `${key}|${JSON.stringify(vars ?? {})}`) as Translator;

describe('mcpSkipsToMessages', () => {
  it('returns an empty array when nothing was skipped', () => {
    expect(mcpSkipsToMessages([], stubTranslator)).toEqual([]);
  });

  it('names the oauth rule for an oauth skip rather than counting it', () => {
    const skipped: McpSkipped[] = [{ agent: 'copilot', source: 'remote', reason: 'oauth' }];
    expect(mcpSkipsToMessages(skipped, stubTranslator)).toEqual([
      'mcp.oauthUnsupported|{"agent":"Copilot"}',
    ]);
  });

  it('names the transport for a transport skip', () => {
    const skipped: McpSkipped[] = [
      { agent: 'copilot', source: 'local-tool', reason: 'transport', transport: 'sse' },
    ];
    expect(mcpSkipsToMessages(skipped, stubTranslator)).toEqual([
      'mcp.transportUnsupported|{"agent":"Copilot","transport":"mcp.protocol.sse|{}"}',
    ]);
  });

  it('distinguishes the two reasons for the same agent instead of merging them into one count', () => {
    const skipped: McpSkipped[] = [
      { agent: 'copilot', source: 'remote', reason: 'oauth' },
      { agent: 'copilot', source: 'local-tool', reason: 'transport', transport: 'sse' },
    ];
    expect(mcpSkipsToMessages(skipped, stubTranslator)).toEqual([
      'mcp.oauthUnsupported|{"agent":"Copilot"}',
      'mcp.transportUnsupported|{"agent":"Copilot","transport":"mcp.protocol.sse|{}"}',
    ]);
  });

  it('deduplicates two presets declined by the same agent for the same reason', () => {
    const skipped: McpSkipped[] = [
      { agent: 'copilot', source: 'remote-a', reason: 'oauth' },
      { agent: 'copilot', source: 'remote-b', reason: 'oauth' },
    ];
    expect(mcpSkipsToMessages(skipped, stubTranslator)).toEqual([
      'mcp.oauthUnsupported|{"agent":"Copilot"}',
    ]);
  });

  it('falls back to the counted message for a transport skip that names no transport', () => {
    const skipped: McpSkipped[] = [
      { agent: 'codex', source: 'instance_1', reason: 'transport' },
      { agent: 'codex', source: 'instance_2', reason: 'transport' },
    ];
    expect(mcpSkipsToMessages(skipped, stubTranslator)).toEqual(['mcp.skippedAgents|{"count":"2"}']);
  });
});
