import type { Meta, StoryObj } from '@storybook/react';
import { ProjectRow } from './ProjectRow';

const meta = {
  title: 'entities/ProjectRow',
  component: ProjectRow,
} satisfies Meta<typeof ProjectRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    project: { id: 'p1', path: '/home/u/work/app', name: 'app', addedAt: '2026-05-01T00:00:00.000Z' },
    addedLabel: 'Added 2026-05-01',
  },
};
