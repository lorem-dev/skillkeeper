import type { Meta, StoryObj } from '@storybook/react';
import { OnboardingLoader } from './OnboardingLoader';

const meta: Meta<typeof OnboardingLoader> = {
  title: 'systems/onboarding/OnboardingLoader',
  component: OnboardingLoader,
};
export default meta;
type Story = StoryObj<typeof OnboardingLoader>;

// The full-screen preloader spinner shown while the welcome screen loads. Use
// the toolbar theme toggle to check light/dark (the scene background follows
// the settings scene color).
export const Default: Story = {
  render: () => <OnboardingLoader />,
};
