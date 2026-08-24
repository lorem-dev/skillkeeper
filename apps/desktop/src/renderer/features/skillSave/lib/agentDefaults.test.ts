import { describe, it, expect } from 'vitest';
import type { AgentKind, InstallManifest, McpInstall, Project } from '@/services/bridge';
import { GLOBAL_SCOPE_ID } from '@/domain';
import { agentChoiceScopes, installedAgentsByScope, mergeAgentDefaults, resolveAgentDefaults } from './agentDefaults';

function project(over: Partial<Project> & { id: string; path: string }): Project {
  return { name: over.id, addedAt: '2026-01-01T00:00:00.000Z', ...over };
}

const ACME = project({ id: 'project-1', path: '/tmp/acme' });
const BETA = project({ id: 'project-2', path: '/tmp/beta' });

/** A project- or global-scoped skill install manifest. */
function skillInstall(over: { projectId?: string; agent: AgentKind; name: string }): InstallManifest {
  return {
    skillId: { name: over.name },
    target:
      over.projectId === undefined
        ? { agent: over.agent, scope: 'global' }
        : { agent: over.agent, scope: 'project', projectId: over.projectId },
    destinationRoot: '/d',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [],
    hookEdits: [],
    sourceRepoId: 'r1',
  };
}

/** An installed MCP instance; `projectId` is the literal 'global' user-wide. */
function mcpInstall(over: { projectId: string; agent: AgentKind; source: string }): McpInstall {
  return {
    projectId: over.projectId,
    agent: over.agent,
    instanceName: over.source,
    identity: { remote: 'git@x:acme/mcp.git', source: over.source },
    hash: 'h',
    hasParams: false,
  };
}

describe('agentChoiceScopes', () => {
  it('resolves the global scope with no project and keeps the given order', () => {
    expect(agentChoiceScopes([GLOBAL_SCOPE_ID, 'project-1'], [ACME])).toEqual([
      { id: GLOBAL_SCOPE_ID },
      { id: 'project-1', project: ACME },
    ]);
  });

  it('drops an id matching neither the global scope nor a tracked project', () => {
    expect(agentChoiceScopes(['ghost', 'project-1'], [ACME])).toEqual([{ id: 'project-1', project: ACME }]);
  });
});

describe('installedAgentsByScope', () => {
  it('unions the skill and MCP sides per scope, deduplicating agents', () => {
    const skills = [
      skillInstall({ projectId: 'project-1', agent: 'claude', name: 'fmt' }),
      skillInstall({ agent: 'codex', name: 'lint' }),
    ];
    const mcp = [
      mcpInstall({ projectId: 'project-1', agent: 'cursor', source: 'github' }),
      // Already on the skill side for this scope -- must not be duplicated.
      mcpInstall({ projectId: 'project-1', agent: 'claude', source: 'github' }),
      mcpInstall({ projectId: GLOBAL_SCOPE_ID, agent: 'opencode', source: 'github' }),
    ];

    expect(installedAgentsByScope(skills, mcp)).toEqual({
      'project-1': ['claude', 'cursor'],
      [GLOBAL_SCOPE_ID]: ['codex', 'opencode'],
    });
  });

  it('reports a scope holding only MCP instances, which the skill side never sees', () => {
    const mcp = [mcpInstall({ projectId: 'project-2', agent: 'cursor', source: 'github' })];

    expect(installedAgentsByScope([], mcp)).toEqual({ 'project-2': ['cursor'] });
  });
});

describe('mergeAgentDefaults', () => {
  // The scenario: detection is slow (cold FS, network-mounted paths, several
  // rows), the user answers the first row, THEN the promise lands.
  it('keeps a scope the user already answered', () => {
    const merged = mergeAgentDefaults(
      { 'project-1': ['claude'], 'project-2': [] },
      { 'project-1': ['cursor'], 'project-2': ['codex'] },
      new Set(['project-1']),
    );

    expect(merged).toEqual({ 'project-1': ['claude'], 'project-2': ['codex'] });
  });

  it('fills every untouched scope, including one the user emptied nothing of', () => {
    const merged = mergeAgentDefaults({}, { 'project-1': ['claude'] }, new Set());

    expect(merged).toEqual({ 'project-1': ['claude'] });
  });

  // A user can legitimately clear a row: that is an answer too, and a late
  // default must not silently re-fill it.
  it('keeps a touched scope even when the user cleared it', () => {
    const merged = mergeAgentDefaults({ 'project-1': [] }, { 'project-1': ['claude'] }, new Set(['project-1']));

    expect(merged).toEqual({ 'project-1': [] });
  });

  it('leaves a current entry the defaults say nothing about', () => {
    const merged = mergeAgentDefaults({ 'project-2': ['codex'] }, { 'project-1': ['claude'] }, new Set());

    expect(merged).toEqual({ 'project-1': ['claude'], 'project-2': ['codex'] });
  });
});

describe('resolveAgentDefaults', () => {
  it('takes a tracked project its detected set', async () => {
    const detect = async (path: string): Promise<AgentKind[]> => (path === '/tmp/acme' ? ['claude', 'cursor'] : []);

    const result = await resolveAgentDefaults(agentChoiceScopes(['project-1'], [ACME]), [], {}, detect);

    expect(result).toEqual({ 'project-1': ['claude', 'cursor'] });
  });

  it('takes the enabled set for the global scope, ignoring detect', async () => {
    const detect = async (): Promise<AgentKind[]> => {
      throw new Error('detect must never be called for the global scope');
    };

    const result = await resolveAgentDefaults(
      agentChoiceScopes([GLOBAL_SCOPE_ID], []),
      ['claude', 'codex'],
      {},
      detect,
    );

    expect(result).toEqual({ [GLOBAL_SCOPE_ID]: ['claude', 'codex'] });
  });

  it('resolves to an empty list when detection rejects', async () => {
    const detect = async (): Promise<AgentKind[]> => {
      throw new Error('folder not readable');
    };

    const result = await resolveAgentDefaults(agentChoiceScopes(['project-2'], [BETA]), [], {}, detect);

    expect(result).toEqual({ 'project-2': [] });
  });

  it('resolves to an empty list when detection finds nothing', async () => {
    const detect = async (): Promise<AgentKind[]> => [];

    const result = await resolveAgentDefaults(agentChoiceScopes(['project-2'], [BETA]), [], {}, detect);

    expect(result).toEqual({ 'project-2': [] });
  });

  it('resolves several scopes independently, global first', async () => {
    const detect = async (path: string): Promise<AgentKind[]> => {
      if (path === '/tmp/acme') return ['claude'];
      if (path === '/tmp/beta') return ['codex', 'cursor'];
      return [];
    };

    const result = await resolveAgentDefaults(
      agentChoiceScopes([GLOBAL_SCOPE_ID, 'project-1', 'project-2'], [ACME, BETA]),
      ['opencode'],
      {},
      detect,
    );

    expect(result).toEqual({
      [GLOBAL_SCOPE_ID]: ['opencode'],
      'project-1': ['claude'],
      'project-2': ['codex', 'cursor'],
    });
  });

  // The choice drives BOTH the skill plan and the MCP plan, and both read an
  // agent missing from the chosen set as "remove this agent's copy". Detection
  // reads folder markers, which know nothing about what this application
  // installed where -- so a default that REPLACED the installed set would plan
  // a removal the user never named.
  it('keeps an agent that already has installs but was not detected', async () => {
    const detect = async (): Promise<AgentKind[]> => ['claude'];

    const result = await resolveAgentDefaults(
      agentChoiceScopes(['project-1'], [ACME]),
      [],
      { 'project-1': ['cursor'] },
      detect,
    );

    expect(result).toEqual({ 'project-1': ['claude', 'cursor'] });
  });

  it('keeps an installed agent when detection finds nothing at all', async () => {
    const detect = async (): Promise<AgentKind[]> => [];

    const result = await resolveAgentDefaults(
      agentChoiceScopes(['project-1'], [ACME]),
      [],
      { 'project-1': ['cursor'] },
      detect,
    );

    expect(result).toEqual({ 'project-1': ['cursor'] });
  });

  it('keeps an installed agent when detection rejects', async () => {
    const detect = async (): Promise<AgentKind[]> => {
      throw new Error('folder not readable');
    };

    const result = await resolveAgentDefaults(
      agentChoiceScopes(['project-1'], [ACME]),
      [],
      { 'project-1': ['cursor'] },
      detect,
    );

    expect(result).toEqual({ 'project-1': ['cursor'] });
  });

  it('keeps a global-scope installed agent the configured set omits', async () => {
    const detect = async (): Promise<AgentKind[]> => [];

    const result = await resolveAgentDefaults(
      agentChoiceScopes([GLOBAL_SCOPE_ID], []),
      ['claude'],
      { [GLOBAL_SCOPE_ID]: ['codex'] },
      detect,
    );

    expect(result).toEqual({ [GLOBAL_SCOPE_ID]: ['claude', 'codex'] });
  });

  it('does not duplicate an agent that is both detected and installed', async () => {
    const detect = async (): Promise<AgentKind[]> => ['claude', 'cursor'];

    const result = await resolveAgentDefaults(
      agentChoiceScopes(['project-1'], [ACME]),
      [],
      { 'project-1': ['cursor'] },
      detect,
    );

    expect(result).toEqual({ 'project-1': ['claude', 'cursor'] });
  });
});
