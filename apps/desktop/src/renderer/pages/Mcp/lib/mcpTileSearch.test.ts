/**
 * Tests for `mcpTileSearchText`, the Components page tile grid's search-field
 * extractor: name, transport type, source repo name (repo presets only), and
 * whichever connection line (url or command) the preset's def yields.
 */
import { describe, it, expect } from 'vitest';
import type { McpPreset } from '@/app/store';
import type { Repository } from '@/services/bridge';
import { mcpTileSearchText } from './mcpTileSearch';

function repo(over: Partial<Repository> & { id: string; name: string }): Repository {
  return {
    url: `git@example.com:acme/${over.id}.git`,
    kind: 'generic',
    transport: 'ssh',
    lfs: false,
    localPath: `/repos/${over.id}`,
    ...over,
  };
}

const REPOS: Repository[] = [repo({ id: 'repo-1', name: 'Team Skills' })];

describe('mcpTileSearchText', () => {
  it('includes name, type, and command for a manual stdio preset', () => {
    const preset: McpPreset = {
      id: 'manual-1',
      origin: 'manual',
      name: 'local-filesystem',
      def: { name: 'local-filesystem', type: 'stdio', command: 'npx', args: ['-y', 'server'] },
      hash: 'sha256:x',
      params: [],
      hasRules: false,
    };
    expect(mcpTileSearchText(preset, REPOS)).toEqual(['local-filesystem', 'stdio', 'npx -y server']);
  });

  it('includes the repo name and url for a repo-origin http preset', () => {
    const preset: McpPreset = {
      id: 'repo:repo-1:devtools:linear',
      origin: 'repo',
      name: 'linear',
      def: { name: 'linear', type: 'http', url: 'https://api.linear.app/mcp' },
      hash: 'sha256:y',
      params: [],
      hasRules: false,
      repoId: 'repo-1',
    };
    expect(mcpTileSearchText(preset, REPOS)).toEqual([
      'linear',
      'http',
      'Team Skills',
      'https://api.linear.app/mcp',
    ]);
  });

  it('omits the repo name when the preset repoId matches no tracked repository', () => {
    const preset: McpPreset = {
      id: 'repo:repo-2:g:x',
      origin: 'repo',
      name: 'x',
      def: { name: 'x', type: 'sse', url: 'https://mcp.example.com/sse' },
      hash: 'sha256:z',
      params: [],
      hasRules: false,
      repoId: 'repo-2',
    };
    expect(mcpTileSearchText(preset, REPOS)).toEqual(['x', 'sse', 'https://mcp.example.com/sse']);
  });

  it('omits the connection field entirely when the def yields neither url nor command', () => {
    const preset: McpPreset = {
      id: 'manual-2',
      origin: 'manual',
      name: 'bare',
      def: { name: 'bare', type: 'stdio' },
      hash: 'sha256:w',
      params: [],
      hasRules: false,
    };
    expect(mcpTileSearchText(preset, REPOS)).toEqual(['bare', 'stdio']);
  });
});
