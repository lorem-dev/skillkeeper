import type { Meta, StoryObj } from '@storybook/react';
import { OnboardingModal } from './OnboardingModal';

const meta: Meta<typeof OnboardingModal> = {
  title: 'systems/onboarding/OnboardingModal',
  component: OnboardingModal,
};
export default meta;
type Story = StoryObj<typeof OnboardingModal>;

export const Default: Story = {
  render: () => (
    <OnboardingModal onNext={() => {}} nextLabel="Get started" onBack={() => {}} backLabel="Back">
      <div>Welcome to SkillKeeper. This short tour walks through installing your first skill.</div>
    </OnboardingModal>
  ),
};

export const Finish: Story = {
  render: () => (
    <OnboardingModal onNext={() => {}} nextLabel="Finish" onBack={() => {}} backLabel="Back">
      <div>That is the whole tour. You can reopen it any time from Settings.</div>
    </OnboardingModal>
  ),
};
