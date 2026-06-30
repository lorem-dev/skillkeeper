import type { Meta, StoryObj } from '@storybook/react';
import { Card } from './Card';

const meta = {
  title: 'shared/ui/Card',
  component: Card,
  args: { children: 'Card content' },
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Solid: Story = {};
export const Glass: Story = { args: { glass: true } };
