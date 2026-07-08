import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta = {
  title: 'shared/ui/Button',
  component: Button,
  args: { children: 'Install skill' },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: 'primary' } };
export const Secondary: Story = { args: { variant: 'secondary' } };
export const Plain: Story = { args: { variant: 'plain' } };
export const Destructive: Story = { args: { variant: 'destructive', children: 'Uninstall' } };
export const Glass: Story = { args: { variant: 'glass' } };
export const PrimaryGlass: Story = { args: { variant: 'primary', glass: true } };
export const SecondaryGlass: Story = { args: { variant: 'secondary', glass: true } };
export const Disabled: Story = { args: { variant: 'primary', disabled: true } };
export const Loading: Story = { args: { variant: 'secondary', loading: true, children: 'Refresh' } };
export const LoadingPrimary: Story = { args: { variant: 'primary', loading: true, children: 'Refresh' } };
