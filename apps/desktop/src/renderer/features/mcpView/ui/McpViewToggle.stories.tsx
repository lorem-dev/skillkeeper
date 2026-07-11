import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { McpViewToggle } from './McpViewToggle';
import type { McpComponentsView } from '@/app/store';

const meta = {
  title: 'features/mcpView/McpViewToggle',
  component: McpViewToggle,
  args: { value: 'tiles', onChange: () => {} },
} satisfies Meta<typeof McpViewToggle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  render: () => {
    const [view, setView] = useState<McpComponentsView>('tiles');
    return (
      <div style={{ padding: 24 }}>
        <McpViewToggle value={view} onChange={setView} />
        <p style={{ marginTop: 12, fontSize: 13 }}>Current: {view}</p>
      </div>
    );
  },
};
