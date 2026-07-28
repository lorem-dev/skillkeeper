import { describe, expect, it } from 'vitest';
import { shouldPromptOnSelect } from './sshPrompt';

describe('shouldPromptOnSelect', () => {
  it('prompts for a freshly-chosen locked key', () => {
    expect(shouldPromptOnSelect('locked')).toBe(true);
  });

  it('does not prompt for any other state', () => {
    const others = ['notConfigured', 'missing', 'notAKey', 'unencrypted', 'unlocked'] as const;
    for (const state of others) {
      expect(shouldPromptOnSelect(state)).toBe(false);
    }
  });
});
