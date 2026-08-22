import type { Meta, StoryObj } from '@storybook/react';
import { Checkbox } from './Checkbox';

const meta = {
  title: 'shared/ui/Checkbox',
  component: Checkbox,
  args: { label: 'Install hooks' },
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {};
export const Checked: Story = { args: { defaultChecked: true } };
export const Disabled: Story = { args: { disabled: true, defaultChecked: true } };

// The `dependency` tone: teal, used for a checkbox that is checked because
// another skill needs it, rather than by hand.
export const DependencyTone: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Checkbox tone="dependency" checked label="Checked as a dependency" onChange={() => undefined} />
      <Checkbox tone="dependency" indeterminate label="Partly, as a dependency" onChange={() => undefined} />
      <Checkbox tone="dependency" checked={false} label="Not selected" onChange={() => undefined} />
      <Checkbox checked label="Checked by hand (default tone)" onChange={() => undefined} />
    </div>
  ),
};
