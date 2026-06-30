import type { Meta, StoryObj } from '@storybook/react';
import { DisclosureGroup } from './DisclosureGroup';

const meta = {
  title: 'shared/ui/DisclosureGroup',
  component: DisclosureGroup,
  args: {
    title: 'Advanced options',
    children: 'Hidden details revealed when expanded.',
  },
} satisfies Meta<typeof DisclosureGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
