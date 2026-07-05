import { describe, expect, it } from 'vitest';
import { deriveRepoName, MAX_REPO_NAME_LENGTH } from './deriveRepoName';

describe('deriveRepoName', () => {
  it('kebab-cased path before .git', () => {
    expect(deriveRepoName('git@github.com:foo/my-cool-repo.git')).toBe('My Cool Repo');
  });
  it('camelCase', () => {
    expect(deriveRepoName('https://github.com/foo/myCoolRepo.git')).toBe('My Cool Repo');
  });
  it('snake_case without .git and trailing slash', () => {
    expect(deriveRepoName('https://example.com/foo/my_cool_repo/')).toBe('My Cool Repo');
  });
  it('empty for a blank url', () => {
    expect(deriveRepoName('')).toBe('');
  });
  it('caps the derived name at MAX_REPO_NAME_LENGTH', () => {
    const long = 'a'.repeat(80);
    expect(deriveRepoName(`https://example.com/foo/${long}.git`).length).toBe(MAX_REPO_NAME_LENGTH);
  });
});
