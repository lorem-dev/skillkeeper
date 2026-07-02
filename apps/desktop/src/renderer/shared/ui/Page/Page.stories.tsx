import type { Meta, StoryObj } from '@storybook/react';
import { Page } from './Page';
import { Toolbar } from '../Toolbar';
import { Button } from '../Button';

const meta = {
  title: 'shared/ui/Page',
  component: Page,
  args: { title: 'Repositories', children: 'Page content goes here.' },
} satisfies Meta<typeof Page>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// With a Toolbar header: the toolbar carries the heading (its title) and the
// trailing actions, so the plain title is not rendered.
export const WithToolbar: Story = {
  args: {
    title: undefined,
    toolbar: <Toolbar title="Repositories" trailing={<Button variant="primary">Add</Button>} />,
    children: 'Page content goes here.',
  },
};
