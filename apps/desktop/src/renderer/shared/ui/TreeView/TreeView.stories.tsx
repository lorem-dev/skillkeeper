import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TreeView } from './TreeView';
import type { TreeNode } from './TreeView';
import { Icon } from '../Icon';
import { ChangeBadge } from '../ChangeBadge';
import { Badge } from '../Badge';
// The Skills page owns the node-label decoration styles (dot + hover badges).
import '@/pages/Skills/SkillsPage.scss';

const meta = {
  title: 'shared/ui/TreeView',
  component: TreeView,
  // Each story renders its own tree via `render`; this default satisfies the
  // required `nodes` prop for the story type.
  args: { nodes: [] },
} satisfies Meta<typeof TreeView>;

export default meta;

type Story = StoryObj<typeof meta>;

const group = <Icon name="skill-group" size={18} />;
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
        icon: group,
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
        icon: group,
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
        icon: group,
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

// Labels wider than the container are truncated with a CSS ellipsis; the full
// text stays available in the row's tooltip.
const LONG_REPO = 'anthropic/an-intentionally-very-long-repository-name-for-testing-truncation';
const LONG_GROUP = 'A skill group with an unusually long descriptive name that keeps going';
const LONG_SKILL =
  'extremely-detailed-skill-name-that-runs-well-past-sixty-four-characters-and-then-some';
const LONG_SKILL_2 =
  'another-very-long-locally-authored-skill-name-that-should-also-truncate-nicely';

const longLabels: TreeNode[] = [
  {
    id: 'repo-long',
    label: LONG_REPO,
    icon: repo,
    selectable: false,
    children: [
      {
        id: 'grp-long',
        label: LONG_GROUP,
        icon: group,
        children: [
          { id: 'sk-long', label: LONG_SKILL, icon: skill },
          { id: 'sk-short', label: 'short-skill', icon: skill },
        ],
      },
    ],
  },
];

function Checkable({
  nodes,
  expanded,
  levels,
  initial,
}: {
  readonly nodes: TreeNode[];
  readonly expanded: string[];
  readonly levels?: number[];
  readonly initial?: string[];
}) {
  const [checkedIds, setCheckedIds] = useState<string[]>(initial ?? []);
  return (
    <div style={{ width: 340 }}>
      <TreeView
        nodes={nodes}
        checkable
        checkboxLevels={levels}
        checkedIds={checkedIds}
        onCheckedChange={setCheckedIds}
        defaultExpandedIds={expanded}
        ariaLabel="Selectable tree"
      />
    </div>
  );
}

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

// Long labels ellipsize to the container width.
export const LongLabels: Story = {
  render: () => <Interactive nodes={longLabels} expanded={['repo-long', 'grp-long']} />,
};

// Checkbox selection on groups and skills (not the root). One skill is
// pre-checked, so its group shows the "mixed" (dash) state.
export const Checkboxes: Story = {
  render: () => (
    <Checkable
      nodes={repoWithGroups}
      expanded={['repo-1', 'grp-writing', 'grp-debug']}
      levels={[1, 2]}
      initial={['sk-brainstorm']}
    />
  ),
};

// Checkboxes on every level (default). Checking the root checks every skill;
// a partial selection makes the root and a group indeterminate.
export const CheckboxesAllLevels: Story = {
  render: () => (
    <Checkable
      nodes={projectInstalled}
      expanded={['proj-1', 'p-grp-core']}
      initial={['p-sk-brainstorm', 'p-sk-worktrees']}
    />
  ),
};

// A fully-selected group: the folder checkbox shows a check (not just a fill)
// and its count renders as the accent-colored total.
export const CheckboxesGroupAllSelected: Story = {
  render: () => (
    <Checkable
      nodes={repoWithGroups}
      expanded={['repo-1', 'grp-writing', 'grp-debug']}
      levels={[1, 2]}
      initial={['sk-systematic', 'sk-root-cause']}
    />
  ),
};

// Checkboxes on the leaves only (skills), with none on the groups or root.
export const CheckboxesLeavesOnly: Story = {
  render: () => (
    <Checkable
      nodes={repoWithGroups}
      expanded={['repo-1', 'grp-writing', 'grp-debug']}
      levels={[2]}
      initial={['sk-plans', 'sk-clear']}
    />
  ),
};

// Long labels with checkboxes AND badges: the name ellipsizes while the update
// dot + badge stay pinned after it. Hover a row to reveal its "update" badge;
// the "local" status badge on the short skill is always visible.
export const CheckboxesLongLabels: Story = {
  render: () => {
    const nodes: TreeNode[] = [
      {
        id: 'repo-long',
        label: decorate(LONG_REPO, false, { update: true }),
        icon: repo,
        selectable: false,
        children: [
          {
            id: 'grp-long',
            label: decorate(LONG_GROUP, false, { update: true }),
            icon: group,
            children: [
              { id: 'sk-long', label: decorate(LONG_SKILL, false, { update: true }), icon: skill },
              {
                id: 'sk-short',
                label: decorate(LONG_SKILL_2, false, { badge: 'local' }),
                icon: skill,
                muted: true,
              },
            ],
          },
        ],
      },
    ];
    return (
      <Checkable nodes={nodes} expanded={['repo-long', 'grp-long']} levels={[1, 2]} initial={['sk-long']} />
    );
  },
};

// Install-diff column (built with the separate ChangeBadge component, not
// TreeView itself, via each leaf's `detail`): initially-installed skills show a
// gray check; unchecking one turns it into a red "will be removed"; a
// newly-checked skill shows a green "will be added".
const INSTALLED = ['p-sk-brainstorm', 'p-sk-worktrees', 'p-sk-review'];

function withInstallDiff(
  nodes: readonly TreeNode[],
  installed: ReadonlySet<string>,
  checked: ReadonlySet<string>,
): TreeNode[] {
  return nodes.map((node) => {
    if (node.children !== undefined && node.children.length > 0) {
      return { ...node, children: withInstallDiff(node.children, installed, checked) };
    }
    const wasInstalled = installed.has(node.id);
    const isChecked = checked.has(node.id);
    let detail: ReactNode;
    if (wasInstalled && isChecked) detail = <ChangeBadge kind="present" label="Skill already installed" />;
    else if (wasInstalled && !isChecked) detail = <ChangeBadge kind="remove" label="Skill will be removed" />;
    else if (!wasInstalled && isChecked) detail = <ChangeBadge kind="add" label="Skill will be added" />;
    else detail = undefined;
    return { ...node, detail };
  });
}

function InstallDiff() {
  const installed = useMemo(() => new Set(INSTALLED), []);
  const [checkedIds, setCheckedIds] = useState<string[]>(INSTALLED);
  const nodes = withInstallDiff(projectInstalled, installed, new Set(checkedIds));
  return (
    <div style={{ width: 360 }}>
      <TreeView
        nodes={nodes}
        checkable
        checkboxLevels={[1, 2]}
        checkedIds={checkedIds}
        onCheckedChange={setCheckedIds}
        defaultExpandedIds={['proj-1', 'p-grp-core']}
        ariaLabel="Install diff"
      />
    </div>
  );
}

export const InstallStatusColumn: Story = {
  render: () => <InstallDiff />,
};

// Install-diff column with a long skill name: the label ellipsizes before the
// status badge and the checkbox column.
function InstallDiffLongLabels() {
  const installedLong = useMemo(() => new Set(['sk-long']), []);
  const [checkedIds, setCheckedIds] = useState<string[]>(['sk-long']);
  const nodes = withInstallDiff(longLabels, installedLong, new Set(checkedIds));
  return (
    <div style={{ width: 360 }}>
      <TreeView
        nodes={nodes}
        checkable
        checkboxLevels={[1, 2]}
        checkedIds={checkedIds}
        onCheckedChange={setCheckedIds}
        defaultExpandedIds={['repo-long', 'grp-long']}
        ariaLabel="Install diff"
      />
    </div>
  );
}

export const InstallStatusLongLabels: Story = {
  render: () => <InstallDiffLongLabels />,
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

// Project mode with update indicators and orphaned (muted) skills. This mirrors
// how the Skills page decorates a node label: the name, a non-interactive update
// dot when an update is available, then a single badge. The "update" action
// badge shows ONLY while the row is hovered; the "unlinked"/"local" status
// badges are always visible:
//  - "update"    (accent)  -- update the skill / group / repository (hover)
//  - "unlinked"  (warning) -- source repo not tracked; offer to add it. Shown on
//    the removed repository node AND each of its skills.
//  - "local"     (neutral) -- a hand-written local skill
// Orphaned skills (source gone / local) are greyed and remove-only. Toggle
// "updating" to see the dot pulse and the update badge go disabled.
type Deco = { update?: boolean; badge?: 'unlinked' | 'local' };

function decorate(name: string, busy: boolean, deco: Deco = {}): ReactNode {
  let badge: ReactNode = null;
  let hoverOnly = false;
  if (deco.update === true) {
    hoverOnly = true; // action badge -- visible only on row hover
    badge = (
      <button type="button" className="sk-skills-badge-btn" disabled={busy}>
        <Badge tone="accent">update</Badge>
      </button>
    );
  } else if (deco.badge === 'unlinked') {
    badge = (
      <button type="button" className="sk-skills-badge-btn">
        <Badge tone="warning">unlinked</Badge>
      </button>
    );
  } else if (deco.badge === 'local') {
    badge = <Badge tone="neutral">local</Badge>;
  }
  return (
    <span className="sk-skills-nodelabel">
      <span className="sk-skills-name">{name}</span>
      {deco.update === true && (
        <span className={`sk-skills-dot${busy ? ' sk-skills-dot--pulse' : ''}`} aria-hidden="true" />
      )}
      {badge !== null && (
        <span
          className={`sk-skills-badgewrap${hoverOnly ? ' sk-skills-badge--hover' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          {badge}
        </span>
      )}
    </span>
  );
}

function projectWithUpdates(busy: boolean): TreeNode[] {
  return [
    {
      id: 'proj-1',
      label: 'my-app',
      icon: project,
      selectable: false,
      children: [
        {
          id: 'proj-1::repo::r1',
          // The repo has an updatable skill inside -> repo-level update indicator.
          label: decorate('anthropic/skills', busy, { update: true }),
          icon: repo,
          children: [
            {
              id: 'proj-1::r1::writing',
              label: decorate('writing', busy, { update: true }),
              icon: group,
              children: [
                { id: 'sk-a', label: 'condense', icon: skill },
                { id: 'sk-b', label: decorate('brainstorm', busy, { update: true }), icon: skill },
              ],
            },
          ],
        },
        {
          // A dangling repo (removed): the repo node itself is "unlinked" (add it
          // back to re-link all its skills), and every skill is orphaned -> muted.
          id: 'proj-1::repo::gone',
          label: decorate('acme/legacy', busy, { badge: 'unlinked' }),
          icon: repo,
          muted: true,
          children: [
            {
              id: 'sk-orphan-1',
              label: decorate('old-helper', busy, { badge: 'unlinked' }),
              icon: skill,
              muted: true,
            },
            {
              id: 'sk-orphan-2',
              label: decorate('retired', busy, { badge: 'unlinked' }),
              icon: skill,
              muted: true,
            },
          ],
        },
        // An unmanaged skill: present in the project but not from a repository.
        // Sits at the repository level, grey and remove-only, with a "local" badge.
        { id: 'sk-unmanaged', label: decorate('hand-installed', busy, { badge: 'local' }), icon: skill, muted: true },
      ],
    },
  ];
}

function ProjectUpdates() {
  const [busy, setBusy] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([
    'sk-a',
    'sk-b',
    'sk-orphan-1',
    'sk-orphan-2',
    'sk-unmanaged',
  ]);
  return (
    <div style={{ width: 380 }}>
      <button type="button" onClick={() => setBusy((b) => !b)} style={{ marginBottom: 12 }}>
        {busy ? 'Stop updating' : 'Start updating'}
      </button>
      <TreeView
        nodes={projectWithUpdates(busy)}
        checkable
        checkboxLevels={[1, 2, 3]}
        checkedIds={checkedIds}
        onCheckedChange={setCheckedIds}
        defaultExpandedIds={['proj-1', 'proj-1::repo::r1', 'proj-1::r1::writing', 'proj-1::repo::gone']}
        ariaLabel="Project updates"
      />
    </div>
  );
}

export const ProjectIndicators: Story = {
  render: () => <ProjectUpdates />,
};

// MCP rows (Skills page, design spec "MCP support" section 8, option B): an
// MCP server preset/instance renders inline with skill leaves using the `mcp`
// icon and a trailing Install/Remove badge INSTEAD of a checkbox -- the
// checkbox column is left empty for these rows, and they never count toward a
// group/repo's checkbox total (2/2 below reflects only the two skills; the two
// MCP rows opt out entirely).
const mcp = <Icon name="mcp" size={18} />;

function mcpBadge(label: 'Install MCP' | 'Remove'): ReactNode {
  return (
    <span className="sk-skills-badgewrap" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="sk-skills-badge-btn">
        <Badge tone={label === 'Remove' ? 'neutral' : 'accent'}>{label}</Badge>
      </button>
    </span>
  );
}

const repoWithMcp: TreeNode[] = [
  {
    id: 'repo-mcp',
    label: 'anthropic/skills',
    icon: repo,
    selectable: false,
    children: [
      {
        id: 'grp-mcp',
        label: 'Writing',
        icon: group,
        children: [
          { id: 'sk-mcp-1', label: 'Brainstorming', icon: skill },
          { id: 'sk-mcp-2', label: 'Writing plans', icon: skill },
          // A repo-origin MCP preset nested in the same group, after the
          // skills: mcp icon, no checkbox, an "Install MCP" trailing badge.
          { id: 'mcp::repo:r1:writing:docs', label: 'docs-server', icon: mcp, trailing: mcpBadge('Install MCP') },
        ],
      },
      // An ungrouped MCP preset directly under the repo root.
      { id: 'mcp::repo:r1::search', label: 'search-server', icon: mcp, trailing: mcpBadge('Install MCP') },
    ],
  },
];

export const McpLeavesRepoMode: Story = {
  render: () => <Checkable nodes={repoWithMcp} expanded={['repo-mcp', 'grp-mcp']} levels={[1, 2]} />,
};

// Projects mode: an already-installed MCP instance shows a "Remove" badge; a
// not-yet-installed repo preset shows "Install MCP". Both are leaves, neither
// has a checkbox.
const projectWithMcp: TreeNode[] = [
  {
    id: 'proj-mcp',
    label: 'my-app',
    icon: project,
    selectable: false,
    children: [
      {
        id: 'proj-mcp::repo::r1',
        label: 'anthropic/skills',
        icon: repo,
        children: [
          { id: 'p-sk-a', label: 'condense', icon: skill },
          { id: 'mcp::proj-mcp::install::docs', label: 'docs-server', icon: mcp, trailing: mcpBadge('Remove') },
          {
            id: 'mcp::proj-mcp::repo:r1::search',
            label: 'search-server',
            icon: mcp,
            trailing: mcpBadge('Install MCP'),
          },
        ],
      },
    ],
  },
];

export const McpLeavesProjectMode: Story = {
  render: () => (
    <Checkable nodes={projectWithMcp} expanded={['proj-mcp', 'proj-mcp::repo::r1']} levels={[1, 2, 3]} initial={['p-sk-a']} />
  ),
};
