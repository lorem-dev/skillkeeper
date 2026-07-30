import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { seedStore } from '@/app/store/storyState';
import type { SkillKeeperConfig } from '@/app/store';
import type { AgentKind, McpInstall, Project } from '@/services/bridge';
import { GLOBAL_SCOPE_ID } from '@/domain';
import { AgentChoiceModal } from './AgentChoiceModal';

const meta: Meta<typeof AgentChoiceModal> = {
  title: 'features/skillSave/AgentChoiceModal',
  component: AgentChoiceModal,
};
export default meta;
type Story = StoryObj<typeof AgentChoiceModal>;

const PROJECT_ACME: Project = {
  id: 'project-1',
  name: 'Acme App',
  path: '/tmp/acme-app',
  addedAt: '2026-01-01T00:00:00.000Z',
};

const PROJECT_BETA: Project = {
  id: 'project-2',
  name: 'Beta Service',
  path: '/tmp/beta-service',
  addedAt: '2026-01-02T00:00:00.000Z',
};

const BASE_CONFIG: SkillKeeperConfig = {
  general: { language: 'en', theme: 'system', animations: 'normal' },
  updates: { mode: 'manual', intervalMinutes: 720, checkOnStartup: false },
  agents: { enabled: ['claude', 'codex'], overrides: {} },
  executables: { globs: [] },
  security: { hookConsentPolicy: 'always-ask' },
  notifications: { enabled: true },
  repositories: { gitPath: 'git' },
  projects: { checkIntervalMinutes: 1 },
  mcp: { servers: [] },
};

/**
 * Seeds `config`/`projects`, plus the installed MCP instances a default must
 * never drop an agent from; no bridge involved (see `fakeDetect` below).
 */
function seedAgentChoice(
  config: SkillKeeperConfig,
  projects: readonly Project[],
  mcpInstalls: readonly McpInstall[] = [],
): void {
  seedStore(() => {
    useSkillkeeperStore.setState({ projects: [...projects], config, mcpInstalls: [...mcpInstalls] });
  });
}

/**
 * A fixture-backed fake for the modal's `detectAgents` prop: the real
 * `bridgeClient.detectProjectAgents` calls the Tauri bridge, which is
 * unavailable in Storybook, so passing it here would resolve every project
 * row empty regardless of the fixture (indistinguishable from a real "found
 * nothing" detection). `detected` maps a project's path to what its folder
 * detection returns; a path with no entry resolves to an empty list.
 */
function fakeDetect(detected: Record<string, AgentKind[]>): (path: string) => Promise<AgentKind[]> {
  return async (path) => detected[path] ?? [];
}

// A single tracked project whose checked skills would install nothing: its
// folder detection finds Claude + Cursor, pre-filling the row.
export const OneProject: Story = {
  render: () => {
    seedAgentChoice(BASE_CONFIG, [PROJECT_ACME]);
    return (
      <AgentChoiceModal
        open
        scopeIds={[PROJECT_ACME.id]}
        onCancel={() => {}}
        onConfirm={() => {}}
        detectAgents={fakeDetect({ [PROJECT_ACME.path]: ['claude', 'cursor'] })}
      />
    );
  },
};

// Several scopes, global first: the global row offers the application's
// configured agents, each project row its own detected set.
export const SeveralScopesWithGlobal: Story = {
  render: () => {
    seedAgentChoice(BASE_CONFIG, [PROJECT_ACME, PROJECT_BETA]);
    return (
      <AgentChoiceModal
        open
        scopeIds={[GLOBAL_SCOPE_ID, PROJECT_ACME.id, PROJECT_BETA.id]}
        onCancel={() => {}}
        onConfirm={() => {}}
        detectAgents={fakeDetect({
          [PROJECT_ACME.path]: ['claude'],
          [PROJECT_BETA.path]: ['codex', 'cursor'],
        })}
      />
    );
  },
};

// Detection finds nothing for this project (an empty/unrecognized folder) --
// the row starts empty and Confirm stays disabled until the user picks agents
// themselves; this is never reported as an error.
export const EmptyDetection: Story = {
  render: () => {
    seedAgentChoice(BASE_CONFIG, [PROJECT_BETA]);
    return (
      <AgentChoiceModal
        open
        scopeIds={[PROJECT_BETA.id]}
        onCancel={() => {}}
        onConfirm={() => {}}
        detectAgents={fakeDetect({})}
      />
    );
  },
};

// The project's folder only carries Claude's marker, but an MCP server was
// installed into it for Cursor. The row must open with BOTH: the chosen set
// drives the MCP plan too, so offering Claude alone would have the review
// propose removing that Cursor server, which the user never asked for.
export const KeepsAnInstalledAgent: Story = {
  render: () => {
    seedAgentChoice(BASE_CONFIG, [PROJECT_ACME], [
      {
        projectId: PROJECT_ACME.id,
        agent: 'cursor',
        instanceName: 'github',
        identity: { remote: 'git@github.com:acme/mcp.git', source: 'github' },
        hash: 'h1',
        hasParams: false,
      },
    ]);
    return (
      <AgentChoiceModal
        open
        scopeIds={[PROJECT_ACME.id]}
        onCancel={() => {}}
        onConfirm={() => {}}
        detectAgents={fakeDetect({ [PROJECT_ACME.path]: ['claude'] })}
      />
    );
  },
};
