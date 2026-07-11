import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import type { SkillKeeperConfig } from '@/app/store';
import type { AvailableMcp, McpInstall, Project, Repository } from '@/services/bridge';
import { ManagementPage } from './ManagementPage';

const meta: Meta<typeof ManagementPage> = { title: 'pages/ManagementPage', component: ManagementPage };
export default meta;
type Story = StoryObj<typeof ManagementPage>;

const REPOSITORIES: Repository[] = [
  {
    id: 'repo-1',
    name: 'Team Skills',
    url: 'git@github.com:acme/team-skills.git',
    kind: 'github',
    transport: 'ssh',
    lfs: false,
    localPath: '/tmp/team-skills',
  },
];

const PROJECTS: Project[] = [
  { id: 'project-1', name: 'Acme App', path: '/tmp/acme-app', addedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'project-2', name: 'Beta Service', path: '/tmp/beta-service', addedAt: '2026-01-02T00:00:00.000Z' },
];

const BASE_CONFIG: SkillKeeperConfig = {
  general: { language: 'en', theme: 'system' },
  updates: { mode: 'manual', intervalMinutes: 720, checkOnStartup: false },
  agents: { enabled: ['claude', 'codex', 'copilot', 'cursor', 'opencode'], overrides: {} },
  executables: { globs: [] },
  security: { hookConsentPolicy: 'always-ask' },
  notifications: { enabled: true },
  repositories: { gitPath: 'git' },
  projects: { checkIntervalMinutes: 1 },
  mcp: { servers: [] },
};

const CONFIG_WITH_MANUAL: SkillKeeperConfig = {
  ...BASE_CONFIG,
  mcp: {
    servers: [
      {
        id: 'manual-1',
        name: 'local-filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '{root_path}'],
      },
    ],
  },
};

const AVAILABLE: AvailableMcp[] = [
  {
    repoId: 'repo-1',
    remote: 'git@github.com:acme/team-skills.git',
    group: 'devtools',
    def: {
      name: 'linear',
      type: 'http',
      url: 'https://api.linear.app/{workspace}/mcp',
      headers: { Authorization: 'Bearer {token}' },
    },
    hash: 'sha256:repo-linear',
  },
  {
    repoId: 'repo-1',
    remote: 'git@github.com:acme/team-skills.git',
    def: { name: 'live-feed', type: 'sse', url: 'https://mcp.example.com/sse/stream' },
    hash: 'sha256:repo-feed',
  },
];

// One installed instance per case the projects tree distinguishes:
//  - `local-filesystem_1` matches the manual preset by `identity.local`, with
//    a deliberately stale `hash` so it renders with the Update badge.
//  - `linear_1` matches the repo preset by (remote, group, source), with the
//    SAME hash as `AVAILABLE[0]` so it renders with no Update badge.
//  - `legacy-server_1` matches nothing current -- unlinked, muted, Delete
//    only.
// Mirrors `McpPage.stories.tsx`'s `INSTALLS` fixture.
const INSTALLS: McpInstall[] = [
  {
    projectId: 'project-1',
    agent: 'claude',
    instanceName: 'local-filesystem_1',
    identity: { local: 'manual-1', source: 'local-filesystem' },
    hash: 'sha256:stale',
    hasParams: false,
  },
  {
    projectId: 'project-1',
    agent: 'claude',
    instanceName: 'linear_1',
    identity: { remote: 'git@github.com:acme/team-skills.git', group: 'devtools', source: 'linear' },
    hash: 'sha256:repo-linear',
    hasParams: true,
  },
  {
    projectId: 'project-1',
    agent: 'cursor',
    instanceName: 'legacy-server_1',
    identity: { source: 'legacy-server' },
    hash: 'sha256:legacy',
    hasParams: false,
  },
];

/**
 * Seeds `config`/`repositories`/`projects` and stubs the bridge calls the
 * page's mount effect makes (`listAvailableMcp`, `listMcpInstalls`,
 * `describeProject`, via `refreshMcpPresets`/`refreshMcpInstalls`/
 * `refreshProjectInfo`) so the real store actions compute `mcpPresets`/
 * `mcpInstalls` from these fixtures instead of throwing on the missing
 * `window.skillkeeper` -- Storybook has no Electron preload bridge. Mirrors
 * `McpPage.stories.tsx`'s own `seedMcp`.
 *
 * Called directly in `render()` (not a `useEffect`) so it runs before
 * `ManagementPage` mounts -- its own mount effect calls `refreshMcpPresets`
 * immediately, and effects fire child-before-parent.
 */
function seedMcp(
  config: SkillKeeperConfig,
  available: readonly AvailableMcp[],
  installs: readonly McpInstall[] = [],
  projects: readonly Project[] = [],
): void {
  (window as unknown as { skillkeeper: unknown }).skillkeeper = {
    listAvailableMcp: async () => available,
    listMcpInstalls: async () => installs,
    describeProject: async () => ({ skillCount: 0, fromReposCount: 0, agentCount: 0 }),
  };
  useSkillkeeperStore.setState({ repositories: REPOSITORIES, projects: [...projects], config });
}

// Two projects: one with an installed instance (Update badge), a matched
// repo instance (no Update badge), and an unlinked instance (Delete only);
// the other with nothing installed yet -- just its repo preset's install
// row. Also shows the top-level manual-preset leaf (Install badge only).
export const Default: Story = {
  render: () => {
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE, INSTALLS, PROJECTS);
    return <ManagementPage />;
  },
};

// No projects at all: the empty-state message instead of a tree.
export const Empty: Story = {
  render: () => {
    seedMcp(BASE_CONFIG, []);
    return <ManagementPage />;
  },
};
