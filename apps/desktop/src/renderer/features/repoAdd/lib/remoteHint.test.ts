import { describe, expect, it } from 'vitest';
import { asSchemeUrl, scpPortMistake } from './remoteHint';

describe('scpPortMistake', () => {
  it('spots a port written in the scp-like form', () => {
    // The colon starts a path there, so this asks for "2222/team/repo.git" on
    // port 22 and fails much later as a public-key refusal.
    expect(scpPortMistake('git@stash.example.net:2222/team/repo.git')).toBe(true);
  });

  it('leaves an ordinary scp-like remote alone', () => {
    expect(scpPortMistake('git@github.com:acme/skills.git')).toBe(false);
    // A path that merely starts with digits is not a port.
    expect(scpPortMistake('git@host:2fa/repo.git')).toBe(false);
  });

  it('leaves scheme urls alone, port or not', () => {
    expect(scpPortMistake('ssh://git@stash.example.net:2222/team/repo.git')).toBe(false);
    expect(scpPortMistake('https://github.com/acme/skills.git')).toBe(false);
  });

  it('rewrites the mistake into a url that carries the port', () => {
    expect(asSchemeUrl('git@stash.example.net:2222/team/repo.git')).toBe(
      'ssh://git@stash.example.net:2222/team/repo.git',
    );
  });

  it('returns anything else unchanged', () => {
    expect(asSchemeUrl('git@github.com:acme/skills.git')).toBe('git@github.com:acme/skills.git');
  });
});
