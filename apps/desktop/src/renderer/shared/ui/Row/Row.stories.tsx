import type { Meta, StoryObj } from '@storybook/react';
import { Row } from './Row';
import { Button } from '../Button';
import { Badge } from '../Badge';

const meta = {
  title: 'shared/Row',
  component: Row,
} satisfies Meta<typeof Row>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    gap: 3,
    children: (
      <>
        <Button variant="primary">Save</Button>
        <Button variant="secondary">Cancel</Button>
        <Badge tone="accent">3 skills</Badge>
      </>
    ),
  },
};

export const SpaceBetween: Story = {
  args: {
    justify: 'between',
    children: (
      <>
        <Badge tone="neutral">main</Badge>
        <Button variant="secondary">Sync</Button>
      </>
    ),
  },
};
