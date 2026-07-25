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
      state.notify('Connection timeout to repository server', 'error');
      state.notify('Failed to parse configuration file', 'error', 'repo-1');
      // A resolution warning: logged, never toasted, and shown by default
      // alongside errors.
      state.notifyResolveWarnings([
        {
          repoId: 'repo-1',
          repoName: 'team-skills',
          message:
            'Unresolved SKILL.md at "group/sub/too-deep": nesting is deeper than a single group; declare it in skillkeeper.repo.yaml to install it.',
        },
      ]);
      state.notify('Branch name copied to the clipboard', 'info', 'repo-2');
      state.openLogs();
    }, []);
    return <LogsPage />;
  },
};
