import type { Meta, StoryObj } from '@storybook/react';
import { Skeleton } from './Skeleton';

const meta = {
  title: 'shared/ui/Skeleton',
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div style={{ width: 240, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Skeleton height={16} />
      <Skeleton height={16} width="70%" />
      <Skeleton height={16} width="40%" />
    </div>
  ),
};
