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

  it('prompts for a freshly chosen locked putty key', () => {
    expect(shouldPromptOnSelect('puttyLocked')).toBe(true);
  });

  it('does not prompt for putty states with nothing to ask', () => {
    // An unencrypted key needs no passphrase, and one already in the agent has
    // been dealt with; a missing agent is a different problem, and a window
    // asking for a passphrase would not fix it.
    expect(shouldPromptOnSelect('puttyUnencrypted')).toBe(false);
    expect(shouldPromptOnSelect('puttyInAgent')).toBe(false);
    expect(shouldPromptOnSelect('puttyNoAgent')).toBe(false);
  });
});
