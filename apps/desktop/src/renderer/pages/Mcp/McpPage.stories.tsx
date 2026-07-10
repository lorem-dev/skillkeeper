import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import type { SkillKeeperConfig } from '@/app/store';
import type { AvailableMcp, McpInstall, Project, Repository } from '@/services/bridge';
import { McpPage } from './McpPage';

const meta: Meta<typeof McpPage> = { title: 'pages/McpPage', component: McpPage };
export default meta;
type Story = StoryObj<typeof McpPage>;

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

const PROJECTS: Project[] = [{ id: 'project-1', name: 'Acme App', path: '/tmp/acme-app', addedAt: '2026-01-01T00:00:00.000Z' }];

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
      {
        id: 'manual-2',
        name: 'analytics-server',
        type: 'http',
        url: 'https://mcp.analytics.example.com/v2/servers/analytics?token={api_token}',
        rules: 'Always confirm before writing.',
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

// One installed instance per case the projects-mode tree distinguishes:
//  - `local-filesystem_1` matches the manual preset by `identity.local`, with
//    a deliberately stale `hash` so it renders with the Update badge.
//  - `linear_1` matches the repo preset by (remote, group, source), with the
//    SAME hash as `AVAILABLE[0]` so it renders with no Update badge.
//  - `legacy-server_1` matches nothing current -- unlinked, muted, Delete only.
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
 * the stub in `store.test.ts`'s `refreshMcpPresets` tests.
 *
 * Called directly in `render()` (not a `useEffect`) so it runs before
 * `McpPage` mounts: its own mount effect calls `refreshMcpPresets`
 * immediately, and effects fire child-before-parent, so seeding from a
 * *parent* effect would lose that race and run against a not-yet-seeded
 * store.
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

// Repositories mode (the default): manual (stdio + http-with-rules) and
// repo-discovered (http + sse) presets, nested under their repository.
export const RepositoriesMode: Story = {
  render: () => {
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE);
    return <McpPage />;
  },
};

// Projects mode: the same presets, but with one installed instance per case
// the tree distinguishes -- a matched manual instance with an Update badge, a
// matched repo instance with none, and an unlinked instance shown muted.
// Switch to "Projects" in the page's own mode Select to see this tree (the
// story seeds the data; it does not force the mode).
export const ProjectsModeData: Story = {
  render: () => {
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE, INSTALLS, PROJECTS);
    return <McpPage />;
  },
};

// No presets at all: the empty-state message instead of a tree.
export const Empty: Story = {
  render: () => {
    seedMcp(BASE_CONFIG, []);
    return <McpPage />;
  },
};
