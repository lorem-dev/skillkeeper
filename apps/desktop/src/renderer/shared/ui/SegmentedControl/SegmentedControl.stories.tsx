import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SegmentedControl } from './SegmentedControl';

const meta = {
  title: 'shared/ui/SegmentedControl',
  component: SegmentedControl,
  // Required props satisfied here; the stateful render below drives selection.
  args: { options: [], value: '', onChange: () => {} },
} satisfies Meta<typeof SegmentedControl>;

export default meta;

type Story = StoryObj<typeof meta>;

const options = [
  { value: 'all', label: 'All' },
  { value: 'installed', label: 'Installed' },
  { value: 'updates', label: 'Updates' },
];

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('all');
    return (
      <SegmentedControl label="Filter" options={options} value={value} onChange={setValue} />
    );
  },
};
