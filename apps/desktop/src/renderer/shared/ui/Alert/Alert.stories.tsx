import type { Meta, StoryObj } from '@storybook/react';
import { Alert } from './Alert';

const meta = {
  title: 'shared/ui/Alert',
  component: Alert,
  args: { title: 'Heads up', children: 'A skill repository finished syncing.' },
} satisfies Meta<typeof Alert>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Info: Story = { args: { tone: 'info' } };
export const Success: Story = { args: { tone: 'success', title: 'Done', children: 'Skill installed.' } };
export const Warning: Story = { args: { tone: 'warning', title: 'Drift detected', children: 'Run verify to inspect.' } };
export const Danger: Story = { args: { tone: 'danger', title: 'Install failed', children: 'See the log for details.' } };
export const TitleOnly: Story = { args: { tone: 'info', title: 'Sync complete', children: undefined } };
