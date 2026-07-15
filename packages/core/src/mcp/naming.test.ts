import { describe, expect, it } from 'vitest';
import { toSnakeCase, allocateInstanceName } from './mcpNaming.js';

describe('toSnakeCase', () => {
  it('snake-cases names', () => {
    expect(toSnakeCase('GitHub MCP')).toBe('git_hub_mcp');
  });

  it('leaves an all-lowercase name unchanged', () => {
    expect(toSnakeCase('github')).toBe('github');
  });
});

describe('allocateInstanceName', () => {
  it('allocates the first free numbered name', () => {
    expect(allocateInstanceName('github', [])).toBe('github_1');
    expect(allocateInstanceName('github', ['github_1', 'github_2'])).toBe('github_3');
    expect(allocateInstanceName('github', ['github_2'])).toBe('github_1');
  });

  it('snake-cases the source before allocating', () => {
    expect(allocateInstanceName('GitHub MCP', [])).toBe('git_hub_mcp_1');
  });
});
