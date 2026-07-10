import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import type { McpPreset } from '@/app/store';
import { McpInstallModal } from './McpInstallModal';

const meta = {
  title: 'features/McpInstallModal',
  component: McpInstallModal,
  args: { open: true, onClose: () => {} },
} satisfies Meta<typeof McpInstallModal>;

export default meta;

type Story = StoryObj<typeof meta>;

const PROJECTS = [
  { id: 'proj-1', path: '/home/user/projects/acme-api', name: 'acme-api', addedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'proj-2', path: '/home/user/projects/acme-web', name: 'acme-web', addedAt: '2026-01-02T00:00:00.000Z' },
];

/** Seeds the store's `projects` list so the Select has real options. */
function useSeedProjects(): void {
  useEffect(() => {
    useSkillkeeperStore.setState({ projects: PROJECTS });
  }, []);
}

const repoHttpPreset: McpPreset = {
  id: 'repo:repo-1:devtools:linear',
  origin: 'repo',
  name: 'linear',
  def: {
    name: 'linear',
    type: 'http',
    url: 'https://api.linear.app/{workspace}/mcp',
    headers: { Authorization: 'Bearer {token}' },
  },
  hash: 'sha256:repo-linear',
  params: ['workspace', 'token'],
  hasRules: false,
  repoId: 'repo-1',
  remote: 'git@github.com:acme/mcps.git',
  group: 'devtools',
};

const manualStdioPreset: McpPreset = {
  id: 'manual-1',
  origin: 'manual',
  name: 'local-filesystem',
  def: {
    name: 'local-filesystem',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{root_path}'],
  },
  hash: 'sha256:manual-fs',
  params: ['root_path'],
  hasRules: false,
};

// Repo http preset with two params -- codex is disabled (http is not
// expressible in its stdio-only TOML config), every other agent is selectable.
export const RepoHttpWithParams: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: { preset: repoHttpPreset },
};

// Manual stdio preset -- every agent (including codex) is selectable.
export const ManualStdio: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: { preset: manualStdioPreset },
};

// Opened from a project's own context: the project is already chosen, so the
// user only picks agents and fills in parameters.
export const PreselectedProject: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: { preset: repoHttpPreset, preselectedProjectId: 'proj-2' },
};
