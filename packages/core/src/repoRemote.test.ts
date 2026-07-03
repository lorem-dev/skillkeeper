import { describe, expect, it } from 'vitest';
import { parseRemote } from './repoRemote.js';

describe('parseRemote', () => {
  it('detects github + ssh for scp-style urls', () => {
    expect(parseRemote('git@github.com:foo/bar.git')).toEqual({ kind: 'github', transport: 'ssh' });
  });
  it('detects bitbucket + https', () => {
    expect(parseRemote('https://bitbucket.org/foo/bar.git')).toEqual({ kind: 'bitbucket', transport: 'https' });
  });
  it('detects ssh:// transport and generic kind', () => {
    expect(parseRemote('ssh://git@example.com/foo/bar.git')).toEqual({ kind: 'generic', transport: 'ssh' });
  });
  it('defaults to https + generic', () => {
    expect(parseRemote('https://example.com/foo/bar')).toEqual({ kind: 'generic', transport: 'https' });
  });
});
