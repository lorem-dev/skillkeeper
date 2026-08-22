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

export const AddDependency: Story = {
  args: { kind: 'add-dependency', label: 'Will be installed as a dependency of another skill' },
};

export const Broken: Story = {
  args: {
    kind: 'broken',
    label: 'A required skill was removed; this skill may not work. Click to restore.',
    onClick: () => undefined,
  },
};

export const All: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <ChangeBadge kind="present" label="Skill already installed" />
      <ChangeBadge kind="add" label="Skill will be added" />
      <ChangeBadge kind="add-dependency" label="Will be installed as a dependency" />
      <ChangeBadge kind="remove" label="Skill will be removed" />
      <ChangeBadge kind="broken" label="A required skill was removed" onClick={() => undefined} />
    </div>
  ),
};
