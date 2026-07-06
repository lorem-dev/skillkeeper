import type { Meta, StoryObj } from '@storybook/react';
import { ChangeBadge } from './ChangeBadge';

const meta = {
  title: 'shared/ui/ChangeBadge',
  component: ChangeBadge,
  args: { kind: 'add', label: 'Skill will be added' },
} satisfies Meta<typeof ChangeBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Add: Story = {
  args: { kind: 'add', label: 'Skill will be added' },
};

export const Remove: Story = {
  args: { kind: 'remove', label: 'Skill will be removed' },
};

export const Present: Story = {
  args: { kind: 'present', label: 'Skill already installed' },
};

export const All: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <ChangeBadge kind="present" label="Skill already installed" />
      <ChangeBadge kind="add" label="Skill will be added" />
      <ChangeBadge kind="remove" label="Skill will be removed" />
    </div>
  ),
};
