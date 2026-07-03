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
    // Start with all selected so the joined labels overflow the fixed width and
    // the trigger shows the "Selected N" summary; deselect to see the labels.
    const [value, setValue] = useState<string[]>(['claude', 'codex', 'copilot', 'cursor', 'opencode']);
    return (
      <div style={{ padding: 40 }}>
        <MultiSelect
          options={agents}
          value={value}
          onChange={setValue}
          placeholder="Choose agents"
          summary={(n) => `Selected ${n}`}
          ariaLabel="Agents"
        />
      </div>
    );
  },
};
