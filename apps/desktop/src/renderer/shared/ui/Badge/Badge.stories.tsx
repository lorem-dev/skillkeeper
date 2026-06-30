import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from './Badge';

const meta = {
  title: 'shared/ui/Badge',
  component: Badge,
  args: { children: 'Installed' },
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Neutral: Story = { args: { tone: 'neutral', children: 'Neutral' } };
export const Accent: Story = { args: { tone: 'accent', children: 'Beta' } };
export const Success: Story = { args: { tone: 'success', children: 'Installed' } };
export const Warning: Story = { args: { tone: 'warning', children: 'Drifted' } };
export const Danger: Story = { args: { tone: 'danger', children: 'Failed' } };
