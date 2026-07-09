import type { Meta, StoryObj } from '@storybook/react';
import { McpCard } from './McpCard';

const meta = {
  title: 'entities/McpCard',
  component: McpCard,
} satisfies Meta<typeof McpCard>;

export default meta;

type Story = StoryObj<typeof meta>;

const base = {
  editLabel: 'Edit preset',
  installLabel: 'Install',
  onInstall: () => {},
};

// Manual preset, stdio transport (command line), no rules.
export const ManualStdio: Story = {
  args: {
    ...base,
    name: 'local-filesystem',
    protocol: 'stdio',
    protocolLabel: 'stdio',
    hasRules: false,
    rulesLabel: 'rules',
    command: 'npx -y @modelcontextprotocol/server-filesystem /home/user/projects',
    copyLabel: 'Copy',
    onCopyCommand: () => {},
    onEdit: () => {},
  },
};

// Repo preset, http transport (url), with rules -- no edit button (read-only).
export const RepoHttpWithRules: Story = {
  args: {
    ...base,
    name: 'github',
    repoName: 'Team Skills',
    goToRepoLabel: 'Go to repository',
    onGoToRepo: () => {},
    protocol: 'http',
    protocolLabel: 'http',
    hasRules: true,
    rulesLabel: 'rules',
    url: 'https://api.githubcopilot.com/mcp/',
    copyLabel: 'Copy',
    onCopyUrl: () => {},
  },
};

// Repo preset, sse transport, no rules.
export const RepoSse: Story = {
  args: {
    ...base,
    name: 'live-feed',
    repoName: 'devtools',
    goToRepoLabel: 'Go to repository',
    onGoToRepo: () => {},
    protocol: 'sse',
    protocolLabel: 'sse',
    hasRules: false,
    rulesLabel: 'rules',
    url: 'https://mcp.example.com/sse/stream',
    copyLabel: 'Copy',
    onCopyUrl: () => {},
  },
};

// Manual preset, http transport, with a very long url to show truncation +
// the copy tooltip.
export const LongUrl: Story = {
  args: {
    ...base,
    name: 'analytics-server',
    protocol: 'http',
    protocolLabel: 'http',
    hasRules: true,
    rulesLabel: 'rules',
    url: 'https://mcp.analytics.example.com/v2/organizations/acme-corp/workspaces/production/servers/analytics?token={api_token}&region=us-east-1',
    copyLabel: 'Copy',
    onCopyUrl: () => {},
    onEdit: () => {},
  },
};

// Manual preset, stdio transport, with a very long command (many args/env) to
// show truncation + the copy tooltip.
export const LongCommand: Story = {
  args: {
    ...base,
    name: 'custom-tooling',
    protocol: 'stdio',
    protocolLabel: 'stdio',
    hasRules: false,
    rulesLabel: 'rules',
    command:
      'node /home/user/tools/mcp-server/dist/index.js --workspace {workspace_root} --config /home/user/.config/mcp/custom-tooling.json --log-level debug --max-connections 10',
    copyLabel: 'Copy',
    onCopyCommand: () => {},
    onEdit: () => {},
  },
};
