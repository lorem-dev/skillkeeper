import { describe, expect, it } from 'vitest';
import { canSubmit } from './sshUnlockState.js';

describe('canSubmit', () => {
  it('needs a passphrase and no in-flight attempt', () => {
    expect(canSubmit({ passphrase: '', busy: false })).toBe(false);
    expect(canSubmit({ passphrase: 'x', busy: false })).toBe(true);
    expect(canSubmit({ passphrase: 'x', busy: true })).toBe(false);
  });

  it('treats whitespace as a real passphrase', () => {
    // A passphrase may legitimately be spaces; only an empty field blocks.
    expect(canSubmit({ passphrase: '   ', busy: false })).toBe(true);
  });
});
