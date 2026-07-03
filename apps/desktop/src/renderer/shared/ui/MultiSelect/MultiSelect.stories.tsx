import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { MultiSelect } from './MultiSelect';

const meta = {
  title: 'shared/ui/MultiSelect',
  component: MultiSelect,
  args: { options: [], value: [], onChange: () => {} },
} satisfies Meta<typeof MultiSelect>;

export default meta;

type Story = StoryObj<typeof meta>;

const agents = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'copilot', label: 'Copilot' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
];

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState<string[]>(['claude', 'codex']);
    return (
      <div style={{ padding: 40, width: 280 }}>
        <MultiSelect options={agents} value={value} onChange={setValue} placeholder="Choose agents" ariaLabel="Agents" />
      </div>
    );
  },
};
