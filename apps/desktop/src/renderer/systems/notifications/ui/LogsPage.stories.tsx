import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { LogsPage } from './LogsPage';

const meta: Meta<typeof LogsPage> = { title: 'systems/LogsPage', component: LogsPage };
export default meta;
type Story = StoryObj<typeof LogsPage>;

export const Empty: Story = {
  render: () => {
    useEffect(() => {
      useSkillkeeperStore.getState().openLogs();
    }, []);
    return <LogsPage />;
  },
};

export const Populated: Story = {
  render: () => {
    useEffect(() => {
      const state = useSkillkeeperStore.getState();
      state.notify('Connection timeout to repository server');
      state.notify('Failed to parse configuration file', 'repo-1');
      state.notify('Insufficient permissions to write skill', 'repo-2');
      state.openLogs();
    }, []);
    return <LogsPage />;
  },
};
