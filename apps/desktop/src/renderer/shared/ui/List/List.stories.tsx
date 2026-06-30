import type { Meta, StoryObj } from '@storybook/react';
import { List } from './List';
import { ListRow } from './ListRow';

const meta = {
  title: 'shared/ui/List',
  component: List,
  // children is required; the renders below provide the real rows.
  args: { children: null },
} satisfies Meta<typeof List>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div style={{ width: 360 }}>
      <List>
        <ListRow title="My Skills" subtitle="github.com/example/skills" />
        <ListRow title="Team Skills" subtitle="github.com/team/skills" />
        <ListRow title="Add repository" onClick={() => undefined} />
      </List>
    </div>
  ),
};

export const Selectable: Story = {
  render: () => (
    <div style={{ width: 360 }}>
      <List>
        <ListRow title="All skills" onClick={() => undefined} selected />
        <ListRow title="Installed" onClick={() => undefined} />
      </List>
    </div>
  ),
};
