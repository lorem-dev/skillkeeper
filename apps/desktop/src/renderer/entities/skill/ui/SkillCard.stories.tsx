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

// A three-level nested group (the deepest a skill can carry) paired with a
// long name: the full "g1/g2/g3/name" label should ellipsize inside the
// card's bounded width instead of stretching it.
export const DeepGroup: Story = {
  args: {
    skill: {
      key: 'platform/lint/rust/clippy-fixups-and-formatting-checks-for-every-crate',
      group: 'platform/lint/rust',
      name: 'clippy-fixups-and-formatting-checks-for-every-crate',
      version: '0.4.0',
      agents: ['claude'], scopes: ['global'], hasHooks: false,
      installedAt: '2026-06-01T00:00:00.000Z', fileCount: 3, hookCount: 0,
      destinationRoot: '/home/u/.claude/skills/clippy-fixups-and-formatting-checks-for-every-crate',
    },
    versionLabel: 'v0.4.0',
    agentLabels: ['Claude'],
  },
};
