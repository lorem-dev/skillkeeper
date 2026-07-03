import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Select } from './Select';

const meta = {
  title: 'shared/ui/Select',
  component: Select,
  args: { options: [], value: '', onChange: () => {} },
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

const options = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'copilot', label: 'Copilot' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
];

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState('claude');
    return <Select label="Agent" options={options} value={value} onChange={setValue} />;
  },
};

export const NoLabel: Story = {
  render: () => {
    const [value, setValue] = useState('claude');
    return <Select options={options} value={value} onChange={setValue} />;
  },
};
