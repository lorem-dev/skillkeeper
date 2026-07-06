import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TreeView } from './TreeView';
import type { TreeNode } from './TreeView';
import { Icon } from '../Icon';

const meta = {
  title: 'shared/ui/TreeView',
  component: TreeView,
  // Each story renders its own tree via `render`; this default satisfies the
  // required `nodes` prop for the story type.
  args: { nodes: [] },
} satisfies Meta<typeof TreeView>;

export default meta;

type Story = StoryObj<typeof meta>;

const folder = <Icon name="folder" size={18} />;
const skill = <Icon name="skills" size={18} />;
const repo = <Icon name="repositories" size={18} />;
const project = <Icon name="projects" size={18} />;

// Repository -> skill groups -> skills. The repository root is not selectable.
const repoWithGroups: TreeNode[] = [
  {
    id: 'repo-1',
    label: 'anthropic/skills',
    icon: repo,
    detail: '12',
    selectable: false,
    children: [
      {
        id: 'grp-writing',
        label: 'Writing',
        icon: folder,
        detail: '3',
        children: [
          { id: 'sk-brainstorm', label: 'Brainstorming', icon: skill },
          { id: 'sk-plans', label: 'Writing plans', icon: skill },
          { id: 'sk-clear', label: 'Writing clearly', icon: skill },
        ],
      },
      {
        id: 'grp-debug',
        label: 'Debugging',
        icon: folder,
        detail: '2',
        children: [
          { id: 'sk-systematic', label: 'Systematic debugging', icon: skill },
          { id: 'sk-root-cause', label: 'Root-cause tracing', icon: skill },
        ],
      },
    ],
  },
];

// Repository with no groups -> skills directly under the root.
const repoFlat: TreeNode[] = [
  {
    id: 'repo-2',
    label: 'lorem/handy-skills',
    icon: repo,
    detail: '3',
    selectable: false,
    children: [
      { id: 'f-git', label: 'git-worktrees', icon: skill },
      { id: 'f-review', label: 'code-review', icon: skill },
      { id: 'f-release', label: 'release-notes', icon: skill },
    ],
  },
];

// A project mixing a grouped and an ungrouped set of installed skills.
const projectInstalled: TreeNode[] = [
  {
    id: 'proj-1',
    label: 'SkillKeeper',
    icon: project,
    detail: '5',
    selectable: false,
    children: [
      {
        id: 'p-grp-core',
        label: 'Core',
        icon: folder,
        detail: '2',
        children: [
          { id: 'p-sk-brainstorm', label: 'Brainstorming', icon: skill },
          { id: 'p-sk-plans', label: 'Writing plans', icon: skill },
        ],
      },
      { id: 'p-sk-worktrees', label: 'git-worktrees', icon: skill },
      { id: 'p-sk-review', label: 'code-review', icon: skill },
      { id: 'p-sk-release', label: 'release-notes', icon: skill },
    ],
  },
];

// A skill whose name exceeds the 64-character cap; the label truncates with an
// ellipsis (the full text stays available in the row's tooltip).
const longLabels: TreeNode[] = [
  {
    id: 'repo-long',
    label: 'anthropic/an-intentionally-very-long-repository-name-for-testing-truncation',
    icon: repo,
    selectable: false,
    children: [
      {
        id: 'grp-long',
        label: 'A skill group with an unusually long descriptive name that keeps going',
        icon: folder,
        children: [
          {
            id: 'sk-long',
            label:
              'extremely-detailed-skill-name-that-runs-well-past-sixty-four-characters-and-then-some',
            icon: skill,
          },
          { id: 'sk-short', label: 'short-skill', icon: skill },
        ],
      },
    ],
  },
];

function Interactive({ nodes, expanded }: { readonly nodes: TreeNode[]; readonly expanded: string[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <div style={{ width: 320 }}>
      <TreeView
        nodes={nodes}
        selectedId={selectedId}
        onSelect={(node) => setSelectedId(node.id)}
        defaultExpandedIds={expanded}
        ariaLabel="Example tree"
      />
    </div>
  );
}

export const RepositoryWithGroups: Story = {
  render: () => <Interactive nodes={repoWithGroups} expanded={['repo-1', 'grp-writing', 'grp-debug']} />,
};

export const RepositoryFlat: Story = {
  render: () => <Interactive nodes={repoFlat} expanded={['repo-2']} />,
};

export const ProjectInstalled: Story = {
  render: () => <Interactive nodes={projectInstalled} expanded={['proj-1', 'p-grp-core']} />,
};

export const Collapsed: Story = {
  render: () => <Interactive nodes={repoWithGroups} expanded={[]} />,
};

// Labels past 64 characters are truncated with an ellipsis; the wider container
// shows the character cap rather than the CSS width ellipsis.
export const LongLabels: Story = {
  render: () => <Interactive nodes={longLabels} expanded={['repo-long', 'grp-long']} />,
};

// A branch ("folder") selected as a whole -- the unit for group operations.
export const FolderSelected: Story = {
  render: () => {
    const [selectedId, setSelectedId] = useState<string | null>('grp-writing');
    return (
      <div style={{ width: 320 }}>
        <TreeView
          nodes={repoWithGroups}
          selectedId={selectedId}
          onSelect={(node) => setSelectedId(node.id)}
          defaultExpandedIds={['repo-1', 'grp-writing', 'grp-debug']}
          ariaLabel="Example tree"
        />
      </div>
    );
  },
};

// A leaf selected.
export const LeafSelected: Story = {
  render: () => {
    const [selectedId, setSelectedId] = useState<string | null>('sk-plans');
    return (
      <div style={{ width: 320 }}>
        <TreeView
          nodes={repoWithGroups}
          selectedId={selectedId}
          onSelect={(node) => setSelectedId(node.id)}
          defaultExpandedIds={['repo-1', 'grp-writing', 'grp-debug']}
          ariaLabel="Example tree"
        />
      </div>
    );
  },
};
