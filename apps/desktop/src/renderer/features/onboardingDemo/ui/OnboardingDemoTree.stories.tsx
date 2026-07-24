import type { Meta, StoryObj } from '@storybook/react';
import { OnboardingDemoTree } from './OnboardingDemoTree';

const meta: Meta<typeof OnboardingDemoTree> = {
  title: 'features/onboardingDemo/OnboardingDemoTree',
  component: OnboardingDemoTree,
};
export default meta;
type Story = StoryObj<typeof OnboardingDemoTree>;

// The component is self-contained (fixture nodes + useTranslator, which falls
// back to English in Storybook, like the other onboarding stories) -- no
// store seeding needed.
export const SkillsInstalled: Story = {
  args: { variant: 'skills-installed' },
};

export const SkillsActions: Story = {
  args: { variant: 'skills-actions' },
};

export const Agents: Story = {
  args: { variant: 'agents' },
};
