import type { Meta, StoryObj } from '@storybook/react';
import { Toolbar } from './Toolbar';
import { Button } from '../Button';

const meta = {
  title: 'shared/ui/Toolbar',
  component: Toolbar,
} satisfies Meta<typeof Toolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div style={{ width: 480 }}>
      <Toolbar title="Skills" trailing={<Button variant="primary">Add</Button>} />
    </div>
  ),
};
