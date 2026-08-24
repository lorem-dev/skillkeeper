/**
 * Drift guard: every surface that renders a `Select` for an option-constrained
 * parameter must also render the hint saying why Confirm/Save is disabled.
 *
 * Such a `Select` starts with nothing selected, and the confirm gate
 * (`paramValueValid`) refuses an unselected one -- so without the hint the user
 * gets a dead button and no stated reason. Three surfaces render that `Select`,
 * and the hint was added to two of them; there is no test that would have
 * noticed, because renderer tests here are node-only and cannot mount a modal.
 * Pinning the source is what the sibling `applyResultReporting.test.ts` and
 * `descriptionRenderSites.test.ts` do for the same class of gap.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const SELECT_SITES: Record<string, string> = {
  'McpInstallModal (install)': '../ui/McpInstallModal.tsx',
  'McpUpdateParamsModal (update)': '../ui/McpUpdateParamsModal.tsx',
  'SkillSaveModal (agent-set change)': '../../skillSave/ui/SkillSaveModal.tsx',
};

describe('every parameter Select states why an unselected one blocks the action', () => {
  for (const [label, relative] of Object.entries(SELECT_SITES)) {
    it(`${label} renders the invalidOption hint beside its Select`, () => {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      // Both, and in this order: a file with the hint but no `Select` would
      // mean the control was replaced and the hint left behind.
      expect(source).toContain('<Select');
      expect(source).toContain("t('mcp.error.invalidOption')");
    });
  }
});
