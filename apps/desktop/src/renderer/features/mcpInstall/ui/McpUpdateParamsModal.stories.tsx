/**
 * The update prompt, which asks only for the parameters the new source def
 * introduced. Its controls are the install modal's: an option-constrained
 * parameter is a `Select`, not a text field, so a value outside the option set
 * cannot be submitted from here -- and the description the author wrote for
 * that parameter is shown above it.
 */
import type { Meta, StoryObj } from '@storybook/react';
import type { McpPreset } from '@/app/store';
import type { DescriptionSpan } from '@/services/bridge';
import { McpUpdateParamsModal } from './McpUpdateParamsModal';

const meta = {
  title: 'features/McpUpdateParamsModal',
  component: McpUpdateParamsModal,
  args: { open: true, onClose: () => {}, onConfirm: () => {} },
} satisfies Meta<typeof McpUpdateParamsModal>;

export default meta;

type Story = StoryObj<typeof meta>;

const ACCESS_DESCRIPTION = 'How much of the tracker this instance may touch.';
const WORKSPACE_DESCRIPTION = 'The workspace slug to connect to.';

/** Same seam and same contract as `McpInstallModal.stories.tsx`'s `fakeSpans`:
 *  the real bridge command is unavailable in Storybook. */
function fakeSpans(
  byDescription: Record<string, DescriptionSpan[]>,
): (descriptions: string[]) => Promise<DescriptionSpan[][]> {
  return async (descriptions) =>
    descriptions.map((d) => byDescription[d] ?? (d === '' ? [] : [{ kind: 'text', text: d }]));
}

const preset: McpPreset = {
  id: 'repo:repo-1:devtools:ticket-tracker',
  origin: 'repo',
  name: 'ticket-tracker',
  def: {
    name: 'ticket-tracker',
    type: 'http',
    url: 'https://mcp.example.com/{workspace}/mcp',
    headers: { 'X-Access-Level': '{access}' },
    parameters: {
      access: {
        description: ACCESS_DESCRIPTION,
        options: [
          { value: 'read', label: 'Read-only' },
          { value: 'write', label: 'Read and write' },
        ],
      },
      workspace: { description: WORKSPACE_DESCRIPTION, options: [] },
    },
  },
  hash: 'sha256:repo-ticket-tracker',
  params: ['access', 'workspace'],
  hasRules: false,
  repoId: 'repo-1',
  remote: 'git@github.com:acme/mcps.git',
  group: 'devtools',
};

const spans = fakeSpans({
  [ACCESS_DESCRIPTION]: [{ kind: 'text', text: ACCESS_DESCRIPTION }],
  [WORKSPACE_DESCRIPTION]: [{ kind: 'text', text: WORKSPACE_DESCRIPTION }],
});

// The newly required parameter carries `options`, so it is a Select with its
// description above it. Update stays disabled until a value is picked.
export const OptionConstrainedParameter: Story = {
  args: { preset, missingParams: ['access'], getDescriptionSpans: spans },
};

// A described parameter with no options stays a text field, exactly as before
// options existed.
export const DescribedFreeTextParameter: Story = {
  args: { preset, missingParams: ['workspace'], getDescriptionSpans: spans },
};

// Both at once, which is what a def introducing two placeholders produces.
export const BothKinds: Story = {
  args: { preset, missingParams: ['access', 'workspace'], getDescriptionSpans: spans },
};
