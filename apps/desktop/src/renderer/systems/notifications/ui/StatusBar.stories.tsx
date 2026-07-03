import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { StatusBar } from './StatusBar';

const meta: Meta<typeof StatusBar> = { title: 'systems/StatusBar', component: StatusBar };
export default meta;
type Story = StoryObj<typeof StatusBar>;

export const Empty: Story = {};

export const WithErrors: Story = {
  render: () => {
    useEffect(() => {
      // Seed the store so the badge renders a count.
      const state = useSkillkeeperStore.getState();
      state.notify('Example error 1');
      state.notify('Example error 2');
      state.notify('Example error 3');
    }, []);
    return <StatusBar />;
  },
};
