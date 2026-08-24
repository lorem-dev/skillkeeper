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
    // Editing an existing preset shows the Delete action; the page owns
    // confirming it (see the ComponentsPage stories for the full flow).
    onDelete: () => {},
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

// An http preset with no oauth section filled in -- shows the empty oauth
// fields (client id, callback port, no scopes) with no errors.
export const OauthEmpty: Story = {
  args: {
    preset: {
      id: 'preset-oauth-empty',
      name: 'oauth-empty',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    },
  },
};

// An http preset with a fully filled oauth block: client id, a callback
// port, and two scopes.
export const OauthFilled: Story = {
  args: {
    preset: {
      id: 'preset-oauth-filled',
      name: 'oauth-filled',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      oauth: {
        clientId: 'example-client',
        callbackPort: 8432,
        scopes: ['read', 'write'],
      },
    },
  },
};

// An invalid oauth block: the callback port is out of range AND the client id
// is blank (whitespace only). Only the first error is marked and explained --
// the modal deliberately surfaces one at a time, in the order a user fills the
// form in -- so this shows the client-id message; fixing it reveals the port
// one. Save stays disabled while either stands.
export const OauthInvalid: Story = {
  args: {
    preset: {
      id: 'preset-oauth-invalid',
      name: 'oauth-invalid',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      oauth: {
        clientId: ' ',
        callbackPort: 70000,
        scopes: [],
      },
    },
  },
};

// A stdio preset carrying an oauth block -- the state reached by filling in
// OAuth under http and then switching the transport to stdio. The OAuth
// section is gone (it is http/sse only) and Save is disabled, so the error
// message under the transport select is the only thing that explains why.
export const OauthOnStdio: Story = {
  args: {
    preset: {
      id: 'preset-oauth-on-stdio',
      name: 'oauth-on-stdio',
      type: 'stdio',
      command: 'run-server',
      oauth: {
        clientId: 'example-client',
        scopes: ['read'],
      },
    },
  },
};

// A blank scope entry: the scopes editor marks the offending row and, unlike
// before, says what is wrong with it.
export const OauthScopeBlank: Story = {
  args: {
    preset: {
      id: 'preset-oauth-scope-blank',
      name: 'oauth-scope-blank',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      oauth: {
        clientId: 'example-client',
        scopes: ['read', ' '],
      },
    },
  },
};
