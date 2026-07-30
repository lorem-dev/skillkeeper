import type { Meta, StoryObj } from '@storybook/react';
import { GlobalScopeCard } from './GlobalScopeCard';

const meta = {
  title: 'entities/GlobalScopeCard',
  component: GlobalScopeCard,
} satisfies Meta<typeof GlobalScopeCard>;

export default meta;

type Story = StoryObj<typeof meta>;

// Both badges filled, as it renders once skills and agents have a user-wide
// install.
export const Default: Story = {
  args: {
    name: 'Global',
    hint: 'Installed for this user, in every project',
    skillCountLabel: '7 skills',
    skillCountHint: '7 skills installed',
    agentsLabel: '2 agents',
    agentsHint: '2 agents',
  },
};

// No installs yet: neither badge is shown (mirrors ProjectCard's undefined-count
// behaviour).
export const Empty: Story = {
  args: {
    name: 'Global',
    hint: 'Installed for this user, in every project',
  },
};
