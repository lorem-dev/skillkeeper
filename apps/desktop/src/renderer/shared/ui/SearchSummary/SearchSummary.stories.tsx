import type { Meta, StoryObj } from '@storybook/react';
import { SearchSummary } from './SearchSummary';

const meta = {
  title: 'shared/ui/SearchSummary',
  component: SearchSummary,
} satisfies Meta<typeof SearchSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SomeResults: Story = {
  args: {
    foundLabel: 'Found 3 projects',
    totalLabel: '12 projects total',
    showAllLabel: 'Show all projects',
    onShowAll: () => {},
  },
};

export const NoResults: Story = {
  args: {
    foundLabel: 'Found 0 projects',
    totalLabel: '12 projects total',
    showAllLabel: 'Show all projects',
    onShowAll: () => {},
  },
};

export const Repositories: Story = {
  args: {
    foundLabel: 'Found 1 repository',
    totalLabel: '5 repositories total',
    showAllLabel: 'Show all repositories',
    onShowAll: () => {},
  },
};
