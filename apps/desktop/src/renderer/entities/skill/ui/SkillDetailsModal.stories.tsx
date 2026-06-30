import type { Meta, StoryObj } from '@storybook/react';
import { SkillDetailsModal } from './SkillDetailsModal';

const meta = {
  title: 'entities/SkillDetailsModal',
  component: SkillDetailsModal,
  args: { open: true, onClose: () => {} },
} satisfies Meta<typeof SkillDetailsModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    skill: {
      key: 'web/api-helper',
      group: 'web',
      name: 'api-helper',
      version: '1.2.0',
      agents: ['claude', 'codex'],
      scopes: ['global'],
      hasHooks: true,
      installedAt: '2026-06-01T00:00:00.000Z',
      fileCount: 7,
      hookCount: 1,
      destinationRoot: '/home/u/.claude/skills/api-helper',
    },
    title: 'Skill details',
    filesLabel: '7 files',
    hooksLabel: '1 hooks',
    installedAtLabel: 'Installed: 2026-06-01',
    destinationLabel: 'Destination',
    agentLabels: ['Claude', 'Codex'],
    verifyLabel: 'Verify',
    updateLabel: 'Update',
    comingSoonLabel: 'Coming soon',
  },
};
