import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore, normalizeMcpDefFromBridge, repoMcpPresetId, scanMcpParams } from '@/app/store';
import { seedStore } from '@/app/store/storyState';
import type { McpPreset } from '@/app/store';
import type { DescriptionSpan, RawMcpServerDef } from '@/services/bridge';
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
    seedStore(() => {
      useSkillkeeperStore.setState({ projects: PROJECTS });
    });
  }, []);
}

/**
 * A fixture-backed fake for the modal's `getDescriptionSpans` prop: the real
 * `bridgeClient.mcpDescriptionSpans` calls the Tauri bridge, which is
 * unavailable in Storybook (see `AgentChoiceModal.stories.tsx`'s `fakeDetect`
 * for the same seam on a different modal). `byDescription` maps a raw
 * description string to the spans the backend would have parsed it into; a
 * description with no entry falls back to a single plain-text span holding
 * that same string, and an empty string (no description authored) resolves
 * to an empty span list, matching `mcp_description_spans`' own contract.
 */
function fakeSpans(
  byDescription: Record<string, DescriptionSpan[]>,
): (descriptions: string[]) => Promise<DescriptionSpan[][]> {
  return async (descriptions) =>
    descriptions.map((d) => byDescription[d] ?? (d === '' ? [] : [{ kind: 'text', text: d }]));
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
    parameters: {},
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
    parameters: {},
  },
  hash: 'sha256:manual-fs',
  params: ['root_path'],
  hasRules: false,
};

const oauthHttpPreset: McpPreset = {
  id: 'manual-oauth-1',
  origin: 'manual',
  name: 'oauth-server',
  def: {
    name: 'oauth-server',
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    oauth: {
      clientId: 'example-client',
      callbackPort: 8432,
      scopes: ['read', 'write'],
    },
    parameters: {},
  },
  hash: 'sha256:manual-oauth',
  params: [],
  hasRules: false,
};

const WORKSPACE_DESCRIPTION = 'The workspace slug to connect to.';
const PRIORITY_DESCRIPTION = 'Default priority assigned to new tickets.';
const SERVER_DESCRIPTION = 'Connects to your team ticket tracker over HTTP.';

// A server description plus two described parameters, one of which (priority)
// carries `options` and therefore renders as a Select instead of a TextField.
const describedPreset: McpPreset = {
  id: 'manual-described-1',
  origin: 'manual',
  name: 'ticket-tracker',
  def: {
    name: 'ticket-tracker',
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    description: SERVER_DESCRIPTION,
    parameters: {
      workspace: { description: WORKSPACE_DESCRIPTION, options: [] },
      priority: {
        description: PRIORITY_DESCRIPTION,
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
    },
  },
  hash: 'sha256:manual-described',
  params: ['workspace', 'priority'],
  hasRules: false,
};

// The backend truncates every description to a fixed visible-character budget
// before it ever reaches the renderer (see `description_spans` in
// `apps/desktop/src-tauri/src/commands/mcp.rs`); this fixture's fake spans
// stand in for that already-cut output, ending in the same "..." the real
// command appends. The `priority` option list also carries one deliberately
// long label -- the open question this task exists to answer: does `Select`,
// under the kit's bounded-width/ellipsize rule for triggers, hold up when an
// option label is much longer than the others?
const LONG_SERVER_DESCRIPTION =
  'Connects your workspace to the ticket tracker with full read and write access to issues, comments, attachments, and workflow transitions across every project your account can see, plus webhook management';
const TRUNCATED_SERVER_SPANS: DescriptionSpan[] = [
  {
    kind: 'text',
    text: 'Connects your workspace to the ticket tracker with full read and write access to issues, comments, attachments, and...',
  },
];

const describedPresetLongOption: McpPreset = {
  ...describedPreset,
  id: 'manual-described-2',
  def: {
    ...describedPreset.def,
    description: LONG_SERVER_DESCRIPTION,
    parameters: {
      ...describedPreset.def.parameters,
      priority: {
        description: PRIORITY_DESCRIPTION,
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'urgent', label: 'Urgent - escalate immediately to the on-call incident response rotation' },
        ],
      },
    },
  },
};

// A repo preset exactly as the BRIDGE sends one that declares placeholders and
// no `parameters:` block -- the shape of every `mcp.yml` authored before that
// block existed. `McpServerDef.parameters` is `skip_serializing_if =
// "BTreeMap::is_empty"` in Rust, so the key is simply not there, while the
// generated TypeScript declares it required; pressing Install on such a preset
// threw during render until `normalizeMcpDefFromBridge` filled it in at the
// store boundary. This fixture goes through that same normalizer rather than
// carrying a hand-written `parameters: {}`, so the story starts from the real
// wire shape -- every fixture above quietly carries the key, which is why the
// crash was invisible in Storybook and in the whole renderer suite.
const bridgeShapedDef: RawMcpServerDef = {
  name: 'docs-http',
  type: 'http',
  url: 'https://{host}/docs',
  headers: { Authorization: 'Bearer {token}' },
};

const bridgeShapedDefNormalized = normalizeMcpDefFromBridge(bridgeShapedDef);

const bridgeShapedPreset: McpPreset = {
  id: repoMcpPresetId('repo-1', undefined, bridgeShapedDefNormalized.name),
  origin: 'repo',
  name: bridgeShapedDefNormalized.name,
  def: bridgeShapedDefNormalized,
  hash: 'sha256:repo-docs-http',
  // From the scanner, not from `parameters`: non-empty params with no metadata
  // map at all is precisely the combination that crashed.
  params: scanMcpParams(bridgeShapedDefNormalized),
  hasRules: false,
  repoId: 'repo-1',
  remote: 'git@github.com:acme/mcps.git',
};

// Repo http preset with two params -- every agent (including codex, whose
// TOML config now expresses http) is selectable.
export const RepoHttpWithParams: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: { preset: repoHttpPreset },
};

// The preset above: two plain TextFields, no descriptions, nothing special to
// look at -- which is the point. Before the boundary fix this story could not
// render at all.
export const BridgeShapedWithoutParametersKey: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: { preset: bridgeShapedPreset },
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

// Update flow (design spec section 5 "Update"): reuses this modal with
// `initialValues` -- the known parameter is pre-filled (still editable) while
// the still-missing one starts empty, and the project is preselected,
// mirroring how an update instance is opened.
export const UpdateFlowKnownParams: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: {
    preset: repoHttpPreset,
    preselectedProjectId: 'proj-2',
    initialValues: { workspace: 'acme-workspace' },
  },
};

// An http preset carrying an oauth block: Copilot cannot store a static
// oauth client (`supportsOauth`), so its checkbox is disabled with a
// tooltip explaining why, while every other agent stays selectable.
export const OauthPresetSkipsCopilot: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: { preset: oauthHttpPreset },
};

// A server description plus two described parameters, one of which renders
// as a Select (it carries `options`) rather than a TextField.
export const DescribedParametersWithSelect: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: {
    preset: describedPreset,
    getDescriptionSpans: fakeSpans({
      [SERVER_DESCRIPTION]: [{ kind: 'text', text: SERVER_DESCRIPTION }],
      [WORKSPACE_DESCRIPTION]: [{ kind: 'text', text: WORKSPACE_DESCRIPTION }],
      [PRIORITY_DESCRIPTION]: [{ kind: 'text', text: PRIORITY_DESCRIPTION }],
    }),
  },
};

// The same shape, but the server description is long enough that the backend
// truncates it (fake spans stand in for that already-cut output -- see
// `TRUNCATED_SERVER_SPANS`'s doc comment). The `priority` Select also carries
// one deliberately long option label, which is the layout question this task
// exists to answer: see the task report for what it looked like.
export const LongDescriptionTruncates: Story = {
  render: (args) => {
    useSeedProjects();
    return <McpInstallModal {...args} />;
  },
  args: {
    preset: describedPresetLongOption,
    getDescriptionSpans: fakeSpans({
      [LONG_SERVER_DESCRIPTION]: TRUNCATED_SERVER_SPANS,
      [WORKSPACE_DESCRIPTION]: [{ kind: 'text', text: WORKSPACE_DESCRIPTION }],
      [PRIORITY_DESCRIPTION]: [{ kind: 'text', text: PRIORITY_DESCRIPTION }],
    }),
  },
};
