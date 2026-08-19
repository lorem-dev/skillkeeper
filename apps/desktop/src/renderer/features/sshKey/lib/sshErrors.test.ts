import { describe, expect, it } from 'vitest';
import { sshErrorKey } from './sshErrors.js';

describe('sshErrorKey', () => {
  it('maps known backend codes to message keys', () => {
    expect(sshErrorKey('ssh.keyLocked')).toBe('ssh.keyLocked');
    expect(sshErrorKey('ssh.keyMissing')).toBe('ssh.keyMissing');
    expect(sshErrorKey('ssh.notAPrivateKey')).toBe('ssh.notAPrivateKey');
    expect(sshErrorKey('ssh.hostKeyPrompt')).toBe('ssh.hostKeyPrompt');
  });

  it('leaves raw git output alone', () => {
    // Repository errors are raw git text today and must stay untranslated,
    // otherwise a git message would be rendered as a missing key.
    expect(sshErrorKey('fatal: could not read from remote repository')).toBeNull();
    expect(sshErrorKey('')).toBeNull();
  });

  it('translates the putty codes', () => {
    expect(sshErrorKey('ssh.puttyNeedsAgent')).toBe('ssh.puttyNeedsAgent');
    expect(sshErrorKey('ssh.puttyUnsupportedAlgorithm')).toBe('ssh.puttyUnsupportedAlgorithm');
    expect(sshErrorKey('ssh.puttyDamaged')).toBe('ssh.puttyDamaged');
    expect(sshErrorKey('ssh.puttyExportFailed')).toBe('ssh.puttyExportFailed');
  });
});
