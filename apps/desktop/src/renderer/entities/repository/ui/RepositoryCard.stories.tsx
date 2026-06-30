import type { Meta, StoryObj } from '@storybook/react';
import { RepositoryCard } from './RepositoryCard';

const meta = {
  title: 'entities/RepositoryCard',
  component: RepositoryCard,
} satisfies Meta<typeof RepositoryCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Github: Story = {
  args: {
    repository: {
      id: 'r1', name: 'Team Skills', url: 'git@github.com:acme/skills.git',
      kind: 'github', transport: 'ssh', lfs: true, localPath: '/home/u/.skk/acme',
      lastFetched: '2026-06-20T10:00:00.000Z',
    },
    lfsLabel: 'LFS',
    lastFetchedLabel: 'Last fetched: 2026-06-20',
  },
};

export const NeverFetched: Story = {
  args: {
    repository: {
      id: 'r2', name: 'Personal', url: 'https://github.com/u/skills',
      kind: 'generic', transport: 'https', lfs: false, localPath: '/home/u/.skk/personal',
    },
    lfsLabel: 'LFS',
    lastFetchedLabel: 'Never fetched',
  },
};
