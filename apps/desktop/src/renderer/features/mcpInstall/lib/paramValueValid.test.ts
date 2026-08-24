/**
 * Tests for `paramValueValid`, the gate that keeps a parameter with `options`
 * from being confirmed with a typed value outside them (see
 * `McpInstallModal`'s `allParamsFilled`).
 */
import { describe, it, expect } from 'vitest';
import type { McpParameter } from '@/services/bridge';
import { paramValueValid } from './paramValueValid';

describe('paramValueValid', () => {
  it('requires non-blank text when there is no metadata at all', () => {
    expect(paramValueValid(undefined, '')).toBe(false);
    expect(paramValueValid(undefined, '   ')).toBe(false);
    expect(paramValueValid(undefined, 'anything')).toBe(true);
  });

  it('requires non-blank text when metadata carries no options', () => {
    const meta: McpParameter = { description: 'A free-text field.', options: [] };
    expect(paramValueValid(meta, '')).toBe(false);
    expect(paramValueValid(meta, 'anything')).toBe(true);
  });

  it('accepts only one of the listed option values when options are present', () => {
    const meta: McpParameter = {
      options: [
        { value: 'us-east', label: 'US East' },
        { value: 'eu-west', label: 'EU West' },
      ],
    };
    expect(paramValueValid(meta, 'us-east')).toBe(true);
    expect(paramValueValid(meta, 'eu-west')).toBe(true);
    expect(paramValueValid(meta, 'ap-south')).toBe(false);
    expect(paramValueValid(meta, '')).toBe(false);
  });
});
