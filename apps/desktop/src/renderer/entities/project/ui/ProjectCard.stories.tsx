import type { Meta, StoryObj } from '@storybook/react';
import { Button, Icon } from '@/shared/ui';
import { ProjectCard } from './ProjectCard';

const meta = {
  title: 'entities/ProjectCard',
  component: ProjectCard,
} satisfies Meta<typeof ProjectCard>;

export default meta;

type Story = StoryObj<typeof meta>;

const sampleProject = {
  id: 'p1',
  path: '/Users/dev/projects/my-cool-project',
  name: 'My Cool Project',
  addedAt: '2026-06-20T10:00:00.000Z',
};

// A stand-in for the real OpenProjectButton (which needs the bridge). The real
// control always renders `glass` (either a plain glass Button with no
// detected editors, or a glass SplitButton) -- matched here so the action row
// reads the same as it does wired up in ProjectsPage.
const openControl = (
  <Button variant="secondary" glass aria-label="Open">
    <Icon name="folder" />
  </Button>
);

// Mirrors exactly what ProjectsPage passes per card, so the story's action
// row (open / go-to-skills / edit, all glass) matches the real one.
const base = {
  project: sampleProject,
  missingLabel: 'The folder was deleted or moved',
  pathCopyLabel: 'Copy full path',
  onPathClick: () => {},
  editLabel: 'Edit project',
  removeLabel: 'Remove project',
  openControl,
  onEdit: () => {},
  skillsLabel: 'Go to skills',
  onGoToSkills: () => {},
  onRemove: () => {},
};

export const Default: Story = {
  args: { ...base, skillCountLabel: '7 skills', fromReposLabel: '5 from repos' },
};

export const InfoPending: Story = {
  args: { ...base, infoPending: true },
};

export const Missing: Story = {
  args: { ...base, missing: true, skillCountLabel: '7 skills', fromReposLabel: '5 from repos' },
};

// Long name (>42 chars) and long path (>64 chars): the name truncates at the end
// and the path truncates at the START so the trailing folders stay visible.
export const LongNameAndPath: Story = {
  args: {
    ...base,
    project: {
      ...sampleProject,
      name: 'My Extremely Long Project Name That Overflows The Card Width',
      path: '/Users/dev/workspace/organization/team/very/deeply/nested/monorepo/packages/some-project',
    },
    skillCountLabel: '42 skills',
    fromReposLabel: '30 from repos',
  },
};
