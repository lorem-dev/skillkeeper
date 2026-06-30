import type { Meta, StoryObj } from '@storybook/react';
import { Tooltip } from './Tooltip';
import { Button } from '../Button';

const meta = {
  title: 'shared/ui/Tooltip',
  component: Tooltip,
  // Required props satisfied here; the render below provides the real content.
  args: { content: '', children: null },
} satisfies Meta<typeof Tooltip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tooltip content="Reinstall this skill">
      <Button>Hover me</Button>
    </Tooltip>
  ),
};
