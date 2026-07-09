import type { Meta, StoryObj } from '@storybook/react';
import { McpEditModal } from './McpEditModal';

const meta = {
  title: 'features/McpEditModal',
  component: McpEditModal,
  args: { open: true, onClose: () => {} },
} satisfies Meta<typeof McpEditModal>;

export default meta;

type Story = StoryObj<typeof meta>;

// Create flow: no preset, all fields at their defaults -- Save starts
// disabled (name + command are both required for the default stdio type).
export const Create: Story = {};

// Edit flow: an existing http preset with a header, params in the url and
// rules, and a rules block -- Save starts enabled.
export const EditHttpWithParamsAndRules: Story = {
  args: {
    preset: {
      id: 'preset-1',
      name: 'github',
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/{workspace}',
      headers: { Authorization: 'Bearer {github_token}' },
      rules: 'When using the github MCP server, prefer the {workspace} workspace by default.',
    },
  },
};

// Invalid state: required fields are filled, but the url contains a
// malformed {param} placeholder, so validatePreset flags it and Save stays
// disabled.
export const InvalidParamSyntax: Story = {
  args: {
    preset: {
      id: 'preset-2',
      name: 'broken',
      type: 'http',
      url: 'https://example.com/{bad-name}',
    },
  },
};
