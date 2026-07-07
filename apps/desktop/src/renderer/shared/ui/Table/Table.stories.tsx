import type { Meta, StoryObj } from '@storybook/react';
import { Table } from './Table';
import type { TableColumn, TableRow } from './Table';

const meta = {
  title: 'shared/ui/Table',
  component: Table,
  args: { columns: [], rows: [] },
} satisfies Meta<typeof Table>;

export default meta;

type Story = StoryObj<typeof meta>;

const columns: TableColumn[] = [
  { key: 'project', header: 'Project', width: '1fr' },
  { key: 'repo', header: 'Repository', width: '1fr' },
  { key: 'skill', header: 'Skill', width: '1.4fr' },
  { key: 'action', header: 'Action', width: '8rem' },
];

const rows: TableRow[] = [
  { id: '1', cells: ['SkillKeeper', 'anthropic/skills', 'Writing / Brainstorming', 'Install'] },
  { id: '2', cells: ['SkillKeeper', 'anthropic/skills', 'Writing / Writing plans', 'Install'] },
  { id: '3', cells: ['SkillKeeper', 'lorem/handy-skills', 'git-worktrees', 'Remove'] },
  { id: '4', cells: ['Docs site', 'anthropic/skills', 'Debugging / Root-cause', 'Install'] },
];

export const Default: Story = {
  render: () => (
    <div style={{ width: 640 }}>
      <Table columns={columns} rows={rows} ariaLabel="Pending changes" />
    </div>
  ),
};

export const StickyHeaderScrolling: Story = {
  render: () => {
    const many: TableRow[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      cells: ['SkillKeeper', 'anthropic/skills', `Skill number ${String(i + 1)}`, i % 3 === 0 ? 'Remove' : 'Install'],
    }));
    return (
      <div style={{ width: 640 }}>
        <Table columns={columns} rows={many} stickyHeader maxBodyHeight="240px" ariaLabel="Pending changes" />
      </div>
    );
  },
};

export const Empty: Story = {
  render: () => (
    <div style={{ width: 640 }}>
      <Table columns={columns} rows={[]} emptyText="No pending changes" ariaLabel="Pending changes" />
    </div>
  ),
};
