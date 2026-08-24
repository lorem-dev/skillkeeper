/**
 * Drift guard: every surface that applies an MCP batch must report what came
 * back, not just whether it failed.
 *
 * `ApplyMcpResult`/`UpdateMcpResult` carry `skipped` and per-instance writer
 * `notes` precisely so a declined agent and a dropped auth field reach the
 * user. Two of the three call sites read only `ok` and threw the rest away: a
 * declined Copilot update was completely invisible (nothing happened, no
 * message, and the instance stayed flagged out of date, so the user clicked
 * Update again), and the skill-save modal reported unqualified success over an
 * install the backend had declined.
 *
 * The mappings themselves are unit tested next door. What is NOT otherwise
 * catchable is a call site ceasing to call them -- renderer tests here are
 * node-only, so an async React handler cannot be driven. Pinning the source
 * catches the shape of the regression, which is how both of these got through:
 * a result field added for reporting and then never read. Same reasoning as the
 * `no-restricted-imports` rule guarding `features/skillInstall/ui`.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const CALL_SITES: Record<string, string> = {
  'McpInstallModal (install)': '../ui/McpInstallModal.tsx',
  'useMcpActions (update)': '../../../pages/Mcp/useMcpActions.tsx',
  'SkillSaveModal (agent-set change)': '../../skillSave/ui/SkillSaveModal.tsx',
};

describe('every mcp apply call site reports skips and writer notes', () => {
  for (const [label, relative] of Object.entries(CALL_SITES)) {
    it(`${label} calls both reporters`, () => {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      expect(source).toContain('mcpSkipsToMessages(');
      expect(source).toContain('installNotesToMessages(');
    });
  }
});
