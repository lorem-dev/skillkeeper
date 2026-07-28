import { describe, expect, it } from 'vitest';
import { hasKey } from './hasKey';

describe('hasKey', () => {
  it('is false with nothing chosen', () => {
    expect(hasKey({ state: 'notConfigured' })).toBe(false);
  });

  it('is false for a blank path, whatever the state says', () => {
    // A hand-edited config can hold an empty sshKeyPath.
    expect(hasKey({ state: 'missing', path: '' })).toBe(false);
    expect(hasKey({ state: 'missing', path: '   ' })).toBe(false);
  });

  it('is true once a path is chosen, including one that cannot be read', () => {
    expect(hasKey({ state: 'unlocked', path: '/home/u/.ssh/id_ed25519' })).toBe(true);
    // Missing or unusable still counts: clearing it is exactly what one does.
    expect(hasKey({ state: 'missing', path: '/gone/id_rsa' })).toBe(true);
    expect(hasKey({ state: 'notAKey', path: '/home/u/notes.txt' })).toBe(true);
  });
});
