import type { Meta, StoryObj } from '@storybook/react';
import { ProgressBar } from './ProgressBar';

const meta = {
  title: 'shared/ui/ProgressBar',
  component: ProgressBar,
} satisfies Meta<typeof ProgressBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Determinate: Story = {
  render: () => (
    <div style={{ width: 240 }}>
      <ProgressBar value={0.6} label="Installing" />
    </div>
  ),
};

export const Indeterminate: Story = {
  render: () => (
    <div style={{ width: 240 }}>
      <ProgressBar label="Working" />
    </div>
  ),
};
