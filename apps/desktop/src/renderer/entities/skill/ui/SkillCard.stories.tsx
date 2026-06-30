import type { Meta, StoryObj } from '@storybook/react';
import { SkillCard } from './SkillCard';

const meta = {
  title: 'entities/SkillCard',
  component: SkillCard,
  args: { onOpen: () => {} },
} satisfies Meta<typeof SkillCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    skill: {
      key: 'web/api-helper', group: 'web', name: 'api-helper', version: '1.2.0',
      agents: ['claude', 'codex'], scopes: ['global'], hasHooks: true,
      installedAt: '2026-06-01T00:00:00.000Z', fileCount: 7, hookCount: 1,
      destinationRoot: '/home/u/.claude/skills/api-helper',
    },
    versionLabel: 'v1.2.0',
    agentLabels: ['Claude', 'Codex'],
  },
};
