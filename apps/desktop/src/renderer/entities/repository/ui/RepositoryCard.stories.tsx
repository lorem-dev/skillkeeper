import type { Meta, StoryObj } from '@storybook/react';
import { RepositoryCard } from './RepositoryCard';

const meta = {
  title: 'entities/RepositoryCard',
  component: RepositoryCard,
} satisfies Meta<typeof RepositoryCard>;

export default meta;

type Story = StoryObj<typeof meta>;

const sampleRepository = {
  id: 'r1',
  name: 'Team Skills',
  url: 'git@github.com:acme/skills.git',
  kind: 'github' as const,
  transport: 'ssh' as const,
  lfs: true,
  localPath: '/home/u/.skk/acme',
  lastFetched: '2026-06-20T10:00:00.000Z',
};

export const Idle: Story = {
  args: {
    repository: sampleRepository,
    phase: 'idle',
    hasUpdate: false,
    syncLabel: 'Sync',
    editLabel: 'Edit repository',
    updateLabel: 'Update available',
    onSync: () => {},
    onEdit: () => {},
  },
};

export const HasUpdate: Story = {
  args: {
    repository: sampleRepository,
    phase: 'idle',
    hasUpdate: true,
    syncLabel: 'Sync',
    editLabel: 'Edit repository',
    updateLabel: 'Update available',
    onSync: () => {},
    onEdit: () => {},
  },
};

export const Cloning: Story = {
  args: {
    repository: sampleRepository,
    phase: 'cloning',
    hasUpdate: false,
    syncLabel: 'Sync',
    editLabel: 'Edit repository',
    updateLabel: 'Update available',
    onSync: () => {},
    onEdit: () => {},
  },
};

export const Syncing: Story = {
  args: {
    repository: sampleRepository,
    phase: 'syncing',
    hasUpdate: false,
    syncLabel: 'Sync',
    editLabel: 'Edit repository',
    updateLabel: 'Update available',
    onSync: () => {},
    onEdit: () => {},
  },
};
