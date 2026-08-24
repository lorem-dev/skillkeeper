/**
 * Drift guard for two invariants `McpInstallModal` rests on that no other
 * test in this feature actually pins:
 *
 * 1. The confirm gate (`allParamsFilled`) goes through `paramValueValid`,
 *    which is what keeps a parameter with `options` from being confirmed
 *    with a value outside them. Reverting it to a bare non-blank check would
 *    silently reopen that hole while `paramValueValid.test.ts` kept passing
 *    (that test only pins the helper itself, not that the modal calls it).
 * 2. The only place a description is ever rendered is `DescriptionText`,
 *    which the backend has already parsed and truncated -- never a raw
 *    `.description` string interpolated straight into JSX, which would
 *    bypass both.
 *
 * Renderer tests here are node-only (no jsdom, no React render), so the
 * modal cannot be mounted and queried; what IS checkable is the source
 * text, the same idiom `features/mcpEdit/lib/errorRenderSites.test.ts` uses
 * for validation messages.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const MODAL_SOURCE = readFileSync(new URL('../ui/McpInstallModal.tsx', import.meta.url), 'utf8');

describe('McpInstallModal source invariants', () => {
  it('gates allParamsFilled through paramValueValid', () => {
    const match = /const allParamsFilled = ([\s\S]*?);\n/.exec(MODAL_SOURCE);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('paramValueValid(');
  });

  it('routes canConfirm through allParamsFilled (not straight past it)', () => {
    const match = /const canConfirm = ([^;]+);/.exec(MODAL_SOURCE);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('allParamsFilled');
  });

  it('never interpolates a raw .description string into JSX', () => {
    // Covers the server def, a parameter's metadata under any of its usual
    // local names, and the loop variable itself -- every shape a regression
    // reintroducing a raw render is likely to take.
    const rawDescriptionInterpolation =
      /\{\s*(?:preset\.def\.description|def\.description|meta\??\.description|param\.description)\s*\}/;
    expect(MODAL_SOURCE).not.toMatch(rawDescriptionInterpolation);
  });

  it('renders exactly the server description and one per-parameter description, both through DescriptionText', () => {
    const sites = MODAL_SOURCE.match(/<DescriptionText\b/g) ?? [];
    expect(sites).toHaveLength(2);
  });
});
