import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Toggle } from './Toggle';

const meta = {
  title: 'shared/ui/Toggle',
  component: Toggle,
} satisfies Meta<typeof Toggle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  render: (args) => {
    const [on, setOn] = useState(false);
    return <Toggle {...args} label="Enable hooks" checked={on} onChange={(e) => setOn(e.target.checked)} />;
  },
};

export const Disabled: Story = {
  render: () => <Toggle label="Enable hooks" disabled checked={false} readOnly />,
};
